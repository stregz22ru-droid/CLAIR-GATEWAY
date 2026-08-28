import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { ClairBadResponseError, ClairUnavailableError } from './errors.js';
import { estimateTokens } from './tokens.js';

export interface CompressionResult {
  /** Compressed text returned by CLAIR Base. */
  text: string;
  originalTokens: number;
  compressedTokens: number;
  /** originalTokens / compressedTokens, rounded to 2 decimals. */
  ratio: number;
  /** True when CLAIR itself reported the token counts (otherwise estimated). */
  reportedByClair: boolean;
}

/** Candidate keys for the compressed text inside the CLAIR response. */
const TEXT_KEYS = ['compressed', 'compressed_text', 'compressedText', 'compressed_prompt', 'result'];
/** Candidate keys for the original token count. */
const ORIGINAL_TOKEN_KEYS = [
  'original_tokens',
  'original_token_count',
  'tokens_before',
  'input_tokens',
  'source_tokens',
];
/** Candidate keys for the compressed token count. */
const COMPRESSED_TOKEN_KEYS = [
  'compressed_tokens',
  'compressed_token_count',
  'tokens_after',
  'output_tokens',
  'target_tokens',
];

/** How deep into nested objects the field auto-detection walks. */
const MAX_SCAN_DEPTH = 3;

function findStringField(node: unknown, keys: string[], depth = 0): string | null {
  if (depth > MAX_SCAN_DEPTH || node === null || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === 'object') {
      const found = findStringField(value, keys, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

function findNumberField(node: unknown, keys: string[], depth = 0): number | null {
  if (depth > MAX_SCAN_DEPTH || node === null || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === 'object') {
      const found = findNumberField(value, keys, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

function digPath(node: unknown, dotPath: string): unknown {
  let current: unknown = node;
  for (const segment of dotPath.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * HTTP client for the immutable CLAIR Base service (`POST {CLAIR_BASE_URL}/compress`).
 *
 * The exact response schema of CLAIR Base is implementation-defined, so the
 * client is deliberately tolerant:
 *  - it auto-detects common field names for the compressed text and the token counts;
 *  - the schema can be pinned down with CLAIR_TEXT_FIELD / CLAIR_RESPONSE_FIELD
 *    environment variables without touching the code;
 *  - when CLAIR does not report token counts, they are estimated heuristically.
 */
export class ClairClient {
  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {}

  async compress(text: string): Promise<CompressionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.clairTimeoutMs);
    try {
      const textField = this.cfg.clairTextField ?? 'text';
      const response = await fetch(`${this.cfg.clairBaseUrl}/compress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          [textField]: text,
          session: this.cfg.sessionName,
          mode: this.cfg.compressionMode,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ClairUnavailableError(`CLAIR /compress returned HTTP ${response.status}`);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (err) {
        throw new ClairBadResponseError('CLAIR /compress returned a non-JSON body', err);
      }
      const compressed = this.extractCompressedText(payload);
      if (compressed === null) {
        throw new ClairBadResponseError(
          'Could not find compressed text in the CLAIR response ' +
            '(set CLAIR_RESPONSE_FIELD to pin the field down)',
        );
      }
      const reported = findNumberField(payload, ORIGINAL_TOKEN_KEYS) !== null;
      const originalTokens = findNumberField(payload, ORIGINAL_TOKEN_KEYS) ?? estimateTokens(text);
      const compressedTokens =
        findNumberField(payload, COMPRESSED_TOKEN_KEYS) ?? estimateTokens(compressed);
      const ratio = compressedTokens > 0 ? Number((originalTokens / compressedTokens).toFixed(2)) : 1;
      this.log.debug('CLAIR compression done', {
        original_tokens: originalTokens,
        compressed_tokens: compressedTokens,
        reported_by_clair: reported,
      });
      return { text: compressed, originalTokens, compressedTokens, ratio, reportedByClair: reported };
    } catch (err) {
      if (err instanceof ClairBadResponseError || err instanceof ClairUnavailableError) throw err;
      // Network failure (ECONNREFUSED) or aborted timeout → "unavailable".
      throw new ClairUnavailableError(`CLAIR Base is unreachable at ${this.cfg.clairBaseUrl}`, err);
    } finally {
      clearTimeout(timer);
    }
  }

  private extractCompressedText(payload: unknown): string | null {
    if (this.cfg.clairResponseField) {
      const value = digPath(payload, this.cfg.clairResponseField);
      return typeof value === 'string' && value.length > 0 ? value : null;
    }
    return findStringField(payload, TEXT_KEYS);
  }
}
