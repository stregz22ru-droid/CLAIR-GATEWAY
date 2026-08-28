import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import type { Request, Response as ExpressResponse } from 'express';
import type { Config } from './config.js';
import type { Logger, OperationRecord } from './logger.js';
import { openAiError } from './errors.js';
import type { ClairClient } from './compressor.js';
import { estimateTokens } from './tokens.js';
import { PromptCache } from './cache.js';

export interface ProxyDeps {
  cfg: Config;
  log: Logger;
  clair: ClairClient;
  /** Shared prompt cache; null when disabled via config. */
  cache: PromptCache | null;
}

/**
 * Headers not copied back to the client. content-encoding/content-length are
 * skipped because undici (fetch) already delivers a decompressed stream, so
 * forwarding them would corrupt the body interpretation.
 */
const RESPONSE_SKIP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
]);

/**
 * Builds the upstream URL, tolerating LLM_PROVIDER_URL with or without a /v1
 * suffix:
 *   base "http://llm:4000"              + /v1/chat/completions → http://llm:4000/v1/chat/completions
 *   base "https://api.openai.com/v1"    + /v1/chat/completions → https://api.openai.com/v1/chat/completions
 */
export function buildUpstreamUrl(incomingPath: string, providerUrl: string): string {
  const base = providerUrl.replace(/\/+$/, '');
  let basePath = '';
  try {
    basePath = new URL(base).pathname.replace(/\/+$/, '');
  } catch {
    // loadConfig only strips trailing slashes; a full URL check happens here lazily.
  }
  const path = incomingPath.startsWith('/') ? incomingPath : `/${incomingPath}`;
  if (basePath && (path === basePath || path.startsWith(`${basePath}/`))) {
    return base + path.slice(basePath.length);
  }
  return base + path;
}

/**
 * Per-request A/B override:
 *   X-Clair-Compress: false → bypass compression for this request
 *   X-Clair-Compress: true  → force compression even if disabled by config
 * Missing or unknown value → fall back to the environment setting.
 */
function parseCompressionHeader(req: Request): boolean | null {
  const raw = req.get('x-clair-compress');
  if (raw === undefined) return null;
  const value = raw.trim().toLowerCase();
  if (['false', '0', 'off', 'no'].includes(value)) return false;
  if (['true', '1', 'on', 'yes'].includes(value)) return true;
  return null;
}

export type ContentPart = { type: string; text?: string; [key: string]: unknown };
export type ChatMessage = { role: string; content?: string | ContentPart[] | null; [key: string]: unknown };

interface ValidateOk {
  ok: true;
  model: string;
  messages: ChatMessage[];
  stream: boolean;
}

interface ValidateFail {
  ok: false;
  message: string;
  param: string | null;
}

/** Minimal but strict validation of the OpenAI chat-completion request shape. */
function validateChatRequest(body: unknown): ValidateOk | ValidateFail {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'Request body must be a JSON object', param: null };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.model !== 'string' || b.model.length === 0) {
    return { ok: false, message: "'model' is a required string", param: 'model' };
  }
  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    return { ok: false, message: "'messages' must be a non-empty array", param: 'messages' };
  }
  for (let i = 0; i < b.messages.length; i++) {
    const message = b.messages[i] as Record<string, unknown> | null;
    if (message === null || typeof message !== 'object') {
      return { ok: false, message: `messages[${i}] must be an object`, param: `messages[${i}]` };
    }
    if (typeof message.role !== 'string') {
      return { ok: false, message: `messages[${i}].role must be a string`, param: `messages[${i}].role` };
    }
    const content = message.content;
    if (typeof content === 'string' || content === null) continue;
    if (Array.isArray(content)) {
      for (let j = 0; j < content.length; j++) {
        const part = content[j] as Record<string, unknown> | null;
        if (part === null || typeof part !== 'object' || typeof part.type !== 'string') {
          return {
            ok: false,
            message: `messages[${i}].content[${j}] must be an object with a 'type' field`,
            param: `messages[${i}].content[${j}]`,
          };
        }
      }
      continue;
    }
    return {
      ok: false,
      message: `messages[${i}].content must be a string or an array of content parts`,
      param: `messages[${i}].content`,
    };
  }
  if (b.stream !== undefined && typeof b.stream !== 'boolean') {
    return { ok: false, message: "'stream' must be a boolean", param: 'stream' };
  }
  return { ok: true, model: b.model, messages: b.messages as ChatMessage[], stream: b.stream === true };
}

interface CompressionStats {
  originalTokens: number;
  compressedTokens: number;
  cacheHits: number;
  cacheMisses: number;
  note: string | null;
}

interface TextCompressionOutcome {
  /** Final text to use — compressed when it is shorter, original otherwise. */
  text: string;
}

/**
 * Compresses one text through the cache-then-CLAIR ladder:
 * 1. cache hit  → replay the stored result, CLAIR is not called at all;
 * 2. cache miss → call CLAIR; store the result only when it is actually
 *    shorter than the original, so no-gain outcomes and (via the caller's
 *    error path) transient failures never poison the cache.
 * Token accounting is identical for hits and fresh compressions.
 */
async function compressText(
  text: string,
  clair: ClairClient,
  cache: PromptCache | null,
  stats: CompressionStats,
  log: Logger,
): Promise<TextCompressionOutcome> {
  const key = cache ? PromptCache.keyFor(text) : '';
  if (cache) {
    const hit = cache.get(key);
    if (hit) {
      stats.originalTokens += hit.originalTokens;
      stats.compressedTokens += hit.compressedTokens;
      stats.cacheHits++;
      log.debug('prompt cache hit', { key_prefix: key.slice(0, 12) });
      return { text: hit.text };
    }
    stats.cacheMisses++;
  }
  const result = await clair.compress(text);
  stats.originalTokens += result.originalTokens;
  if (result.text.length < text.length) {
    stats.compressedTokens += result.compressedTokens;
    cache?.set(key, {
      text: result.text,
      originalTokens: result.originalTokens,
      compressedTokens: result.compressedTokens,
    });
    return { text: result.text };
  }
  // Degradation guard: never let compression make the prompt longer.
  stats.compressedTokens += result.originalTokens;
  log.debug('compression skipped: CLAIR output is not shorter than the original');
  return { text };
}

/**
 * Compresses every text-bearing message through CLAIR Base (one call per text
 * part, so multimodal content keeps its structure). Token counters accumulate
 * per part: CLAIR-reported numbers when available, estimates otherwise.
 * Every distinct text goes through the prompt cache first.
 */
async function compressMessages(
  messages: ChatMessage[],
  clair: ClairClient,
  cache: PromptCache | null,
  stats: CompressionStats,
  log: Logger,
): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      if (message.content === '') {
        out.push(message);
        continue;
      }
      const outcome = await compressText(message.content, clair, cache, stats, log);
      out.push({ ...message, content: outcome.text });
      continue;
    }
    if (Array.isArray(message.content)) {
      const parts: ContentPart[] = [];
      for (const part of message.content) {
        if (part.type === 'text' && typeof part.text === 'string' && part.text !== '') {
          const outcome = await compressText(part.text, clair, cache, stats, log);
          parts.push({ ...part, text: outcome.text });
        } else {
          // Non-text parts (images, files, …) pass through untouched.
          parts.push(part);
        }
      }
      out.push({ ...message, content: parts });
      continue;
    }
    out.push(message); // content === null (e.g. assistant tool_calls) — untouched
  }
  return out;
}

/** Fallback token accounting when compression is disabled or failed. */
function collectEstimatedTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (typeof message.content === 'string') {
      total += estimateTokens(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'text' && typeof part.text === 'string') {
          total += estimateTokens(part.text);
        }
      }
    }
  }
  return total;
}

function pickUpstreamHeaders(req: Request, cfg: Config): Headers {
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  headers.set('accept', req.get('accept') ?? 'application/json');
  const authorization = cfg.llmApiKey ? `Bearer ${cfg.llmApiKey}` : req.get('authorization');
  if (authorization) headers.set('authorization', authorization);
  return headers;
}

function copyResponseHeaders(upstream: globalThis.Response, res: ExpressResponse): void {
  upstream.headers.forEach((value, key) => {
    if (RESPONSE_SKIP_HEADERS.has(key)) return;
    res.setHeader(key, value);
  });
}

interface CompletionContext {
  deps: ProxyDeps;
  requestId: string;
  startedAt: number;
  model: string;
  stream: boolean;
  compressionEnabled: boolean;
  stats: CompressionStats;
  status: number;
  llmResponseTokens: number | null;
  logged: boolean;
}

/** Emits the JSONL operation record exactly once per request. */
function logOperation(ctx: CompletionContext): void {
  if (ctx.logged) return;
  ctx.logged = true;
  const { originalTokens, compressedTokens } = ctx.stats;
  const record: OperationRecord = {
    timestamp: new Date().toISOString(),
    session: ctx.deps.cfg.sessionName,
    request_id: ctx.requestId,
    route: 'chat_completions',
    model: ctx.model,
    compression_enabled: ctx.compressionEnabled,
    stream: ctx.stream,
    original_tokens: originalTokens,
    compressed_tokens: compressedTokens,
    saved_tokens: Math.max(0, originalTokens - compressedTokens),
    compression_ratio: compressedTokens > 0 ? Number((originalTokens / compressedTokens).toFixed(2)) : 1,
    cache_hits: ctx.stats.cacheHits,
    cache_misses: ctx.stats.cacheMisses,
    llm_response_tokens: ctx.llmResponseTokens,
    latency_ms: Date.now() - ctx.startedAt,
    status: ctx.status,
    note: ctx.stats.note,
  };
  ctx.deps.log.operation(record);
}

/**
 * Main pipeline: validate → decide compression → compress → forward → log.
 * Every failure mode is answered in the OpenAI error format, so the agent can
 * treat the gateway as a normal OpenAI endpoint.
 */
export function createChatHandler(deps: ProxyDeps): (req: Request, res: ExpressResponse) => Promise<void> {
  return async (req, res) => {
    const ctx: CompletionContext = {
      deps,
      requestId: randomUUID(),
      startedAt: Date.now(),
      model: 'unknown',
      stream: false,
      compressionEnabled: false,
      stats: { originalTokens: 0, compressedTokens: 0, cacheHits: 0, cacheMisses: 0, note: null },
      status: 500,
      llmResponseTokens: null,
      logged: false,
    };
    res.on('finish', () => logOperation(ctx));

    try {
      const validation = validateChatRequest(req.body);
      if (!validation.ok) {
        ctx.status = 400;
        ctx.stats.note = 'validation_failed';
        res
          .status(400)
          .json(openAiError(validation.message, 'invalid_request_error', { param: validation.param, code: 'invalid_request' }));
        return;
      }
      ctx.model = validation.model;
      ctx.stream = validation.stream;

      // --- A/B switch: the header overrides the environment setting ---
      const headerOverride = parseCompressionHeader(req);
      const enabled = headerOverride ?? deps.cfg.compressionEnabled;
      ctx.compressionEnabled = enabled;

      let messages = validation.messages;

      if (!enabled) {
        ctx.stats.note = headerOverride === false ? 'compression_disabled_by_header' : 'compression_disabled_by_config';
        const estimate = collectEstimatedTokens(messages);
        ctx.stats.originalTokens = estimate;
        ctx.stats.compressedTokens = estimate;
      } else {
        try {
          messages = await compressMessages(messages, deps.clair, deps.cache, ctx.stats, deps.log);
          if (ctx.stats.compressedTokens >= ctx.stats.originalTokens) {
            ctx.stats.note = 'compression_no_gain';
          }
        } catch (err) {
          if (deps.cfg.failStrategy === 'fail_closed') {
            deps.log.warn('CLAIR Base unavailable, failing closed', { request_id: ctx.requestId, error: String(err) });
            ctx.status = 503;
            ctx.stats.note = 'clair_unavailable_fail_closed';
            res.status(503).json(
              openAiError(
                'Prompt compression service (CLAIR Base) is unavailable and CLAIR_FAIL_STRATEGY=fail_closed',
                'clair_gateway_error',
                { code: 'clair_unavailable' },
              ),
            );
            return;
          }
          deps.log.warn('CLAIR Base unavailable, forwarding the original prompt (fail_open)', {
            request_id: ctx.requestId,
            error: String(err),
          });
          ctx.stats.note = 'clair_unavailable_fail_open';
          const estimate = collectEstimatedTokens(messages);
          ctx.stats.originalTokens = estimate;
          ctx.stats.compressedTokens = estimate;
        }
      }

      // --- Cache observability: did this request reuse cached compressions? ---
      const cacheHeader =
        !enabled
          ? 'BYPASS'
          : ctx.stats.cacheHits === 0
            ? 'MISS'
            : ctx.stats.cacheMisses === 0
              ? 'HIT'
              : 'PARTIAL';
      res.setHeader('x-clair-cache', cacheHeader);

      // --- Forward to the upstream LLM ---
      const url = buildUpstreamUrl(req.originalUrl, deps.cfg.llmProviderUrl);
      const controller = new AbortController();
      const llmTimer =
        deps.cfg.llmTimeoutMs > 0 ? setTimeout(() => controller.abort(), deps.cfg.llmTimeoutMs) : null;
      res.on('close', () => {
        if (!res.writableEnded) controller.abort(); // client went away — stop paying for the upstream
        logOperation(ctx);
      });

      let upstream: globalThis.Response;
      try {
        upstream = await fetch(url, {
          method: 'POST',
          headers: pickUpstreamHeaders(req, deps.cfg),
          body: JSON.stringify({ ...req.body, messages }),
          signal: controller.signal,
        });
      } catch (err) {
        if (llmTimer) clearTimeout(llmTimer);
        deps.log.error('Upstream LLM request failed', { request_id: ctx.requestId, url, error: String(err) });
        ctx.status = 502;
        ctx.stats.note = 'upstream_unreachable';
        if (!res.headersSent) {
          res.status(502).json(
            openAiError(`Upstream LLM is unreachable: ${String(err)}`, 'clair_gateway_error', {
              code: 'upstream_unreachable',
            }),
          );
        }
        return;
      }

      ctx.status = upstream.status;
      res.status(upstream.status); // pass the upstream status through (200/4xx/5xx)
      if (ctx.stream && llmTimer) {
        // Streaming responses may legitimately live longer than the timeout;
        // the timeout only guards the time until response headers.
        clearTimeout(llmTimer);
      }

      copyResponseHeaders(upstream, res);
      if (!res.getHeader('content-type')) {
        res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
      }

      // SSE and any other streaming payloads are piped chunk-by-chunk, byte-exact.
      const contentType = upstream.headers.get('content-type') ?? '';
      if (upstream.body && (ctx.stream || contentType.includes('event-stream'))) {
        const source = Readable.fromWeb(upstream.body as unknown as NodeWebReadableStream);
        source.on('error', (err: unknown) => {
          deps.log.error('Upstream stream failed', { request_id: ctx.requestId, error: String(err) });
          res.end();
        });
        source.pipe(res);
        return;
      }

      // Non-streaming: pass the body through byte-exact (no re-serialization),
      // but parse it locally to extract usage tokens for the operation log.
      const raw = await upstream.text();
      try {
        const parsed = JSON.parse(raw) as { usage?: { completion_tokens?: number } };
        if (parsed?.usage && typeof parsed.usage.completion_tokens === 'number') {
          ctx.llmResponseTokens = parsed.usage.completion_tokens;
        }
      } catch {
        // Non-JSON upstream body — forward it as is.
      }
      res.send(raw);
    } catch (err) {
      deps.log.error('Unhandled gateway error', { request_id: ctx.requestId, error: String(err) });
      ctx.status = 500;
      if (!res.headersSent) {
        res.status(500).json(openAiError('Internal gateway error', 'clair_gateway_error', { code: 'internal_error' }));
      } else {
        res.end();
      }
    }
  };
}

/**
 * Pass-through proxy for every other /v1/* route (models listing, embeddings,
 * …): no compression, no body transformation — pure transparency.
 */
export function createPassthroughHandler(
  deps: ProxyDeps,
): (req: Request, res: ExpressResponse) => Promise<void> {
  return async (req, res) => {
    const startedAt = Date.now();
    try {
      const url = buildUpstreamUrl(req.originalUrl, deps.cfg.llmProviderUrl);
      const hasBody = !['GET', 'HEAD', 'DELETE'].includes(req.method);
      const upstream = await fetch(url, {
        method: req.method,
        headers: pickUpstreamHeaders(req, deps.cfg),
        body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
      });
      copyResponseHeaders(upstream, res);
      if (!res.getHeader('content-type')) {
        res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
      }
      const raw = await upstream.text();
      res.status(upstream.status).send(raw);
      deps.log.info('passthrough', {
        method: req.method,
        path: req.originalUrl,
        status: upstream.status,
        latency_ms: Date.now() - startedAt,
      });
    } catch (err) {
      deps.log.error('Passthrough request failed', { path: req.originalUrl, error: String(err) });
      if (!res.headersSent) {
        res.status(502).json(
          openAiError('Upstream LLM is unreachable', 'clair_gateway_error', { code: 'upstream_unreachable' }),
        );
      }
    }
  };
}
