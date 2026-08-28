import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { loadConfig } from './config.js';
import type { Config } from './config.js';
import { Logger } from './logger.js';
import { ClairClient } from './compressor.js';
import { PromptCache } from './cache.js';
import { createChatHandler, createPassthroughHandler } from './proxy.js';
import { openAiError } from './errors.js';

export const VERSION = '1.1.0';

export interface BuildOptions {
  config?: Config;
  logger?: Logger;
}

/**
 * Builds the Express application. Kept side-effect free (no listen call) so
 * tests can drive the full HTTP stack via supertest.
 */
export function buildApp(options: BuildOptions = {}): express.Express {
  const cfg = options.config ?? loadConfig();
  const log = options.logger ?? new Logger(cfg.logLevel, cfg.logFile);
  const clair = new ClairClient(cfg, log);
  // One shared cache per app instance: disabled when either limit is zero.
  const cache = cfg.cacheTtlMs > 0 && cfg.cacheMaxEntries > 0 ? new PromptCache(cfg.cacheTtlMs, cfg.cacheMaxEntries) : null;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: `${cfg.bodyLimitMb}mb` }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'clair-gateway', version: VERSION });
  });

  app.post('/v1/chat/completions', createChatHandler({ cfg, log, clair, cache }));

  // Everything else under /v1/* is proxied without compression (models, …).
  app.all('/v1/*', createPassthroughHandler({ cfg, log, clair, cache }));

  // Body-parser failures → OpenAI-style errors.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const e = err as { type?: string; status?: number; message?: string } | null;
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json(openAiError('Request body is not valid JSON', 'invalid_request_error', { code: 'invalid_json' }));
      return;
    }
    if (e?.type === 'entity.too.large') {
      res
        .status(413)
        .json(openAiError(`Request body exceeds the ${cfg.bodyLimitMb} MB limit`, 'invalid_request_error', { code: 'body_too_large' }));
      return;
    }
    if (e?.status === 400) {
      res.status(400).json(openAiError(e.message ?? 'Bad request', 'invalid_request_error', { code: 'bad_request' }));
      return;
    }
    next(err);
  });

  // Unknown routes → OpenAI-style 404.
  app.use((req: Request, res: Response) => {
    res
      .status(404)
      .json(openAiError(`Unknown route: ${req.method} ${req.path}`, 'invalid_request_error', { code: 'not_found' }));
  });

  return app;
}

function isDirectRun(): boolean {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = new Logger(cfg.logLevel, cfg.logFile);
  const app = buildApp({ config: cfg, logger: log });

  const server = app.listen(cfg.port, () => {
    log.info('CLAIR Gateway started', {
      port: cfg.port,
      clair_base_url: cfg.clairBaseUrl,
      llm_provider_url: cfg.llmProviderUrl,
      compression_enabled: cfg.compressionEnabled,
      compression_mode: cfg.compressionMode,
      fail_strategy: cfg.failStrategy,
      cache_enabled: cfg.cacheTtlMs > 0 && cfg.cacheMaxEntries > 0,
      cache_ttl_ms: cfg.cacheTtlMs,
      cache_max_entries: cfg.cacheMaxEntries,
      session: cfg.sessionName,
      version: VERSION,
    });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down', { signal });
    server.closeAllConnections?.();
    server.close(() => {
      // kept for clarity: draining is done, connections closed above
    });
    // Flush the JSONL log, then exit. Force-exit after a grace period.
    void log
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', { error: String(err) });
    void log.close().finally(() => process.exit(1));
  });
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}
