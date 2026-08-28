import fs from 'node:fs';
import path from 'node:path';

export type FailStrategy = 'fail_open' | 'fail_closed';
export type CompressionMode = 'low' | 'medium' | 'high';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Runtime configuration of the gateway.
 * Loaded from environment variables with an optional `.env` file fallback.
 */
export interface Config {
  /** HTTP port the gateway listens on. */
  port: number;
  /** Root URL of the immutable CLAIR Base service. */
  clairBaseUrl: string;
  /** Timeout for a single /compress call, ms. */
  clairTimeoutMs: number;
  /** Optional override for the request field that carries the prompt. */
  clairTextField: string | null;
  /** Optional dot-path to the compressed text inside the CLAIR response. */
  clairResponseField: string | null;
  /** Root URL of the upstream LLM provider (OpenAI-compatible). */
  llmProviderUrl: string;
  /** API key sent to the LLM as `Authorization: Bearer <key>` (optional). */
  llmApiKey: string | null;
  /** Timeout for the LLM request until response headers, ms (0 = disabled). */
  llmTimeoutMs: number;
  /** Compression strength passed to CLAIR Base. */
  compressionMode: CompressionMode;
  /** Global A/B kill-switch; per-request override via the X-Clair-Compress header. */
  compressionEnabled: boolean;
  /** Behaviour when CLAIR Base is unreachable. */
  failStrategy: FailStrategy;
  /** Session label written to the CLAIR request and to the JSONL operation log. */
  sessionName: string;
  /** Console log verbosity. */
  logLevel: LogLevel;
  /** Path of the JSONL operation log; null disables file logging. */
  logFile: string | null;
  /** Max accepted request body size, MB. */
  bodyLimitMb: number;
  /** Prompt-cache entry lifetime, ms (0 disables the cache). */
  cacheTtlMs: number;
  /** Max prompt-cache entries; the least recently used one is evicted (0 disables). */
  cacheMaxEntries: number;
}

/**
 * Minimal `.env` loader without external dependencies.
 * Variables that already exist in the environment are never overwritten.
 */
function loadDotEnv(env: NodeJS.ProcessEnv, file = '.env'): void {
  const fullPath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(fullPath)) return;
  const content = fs.readFileSync(fullPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}

function str(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key];
  return value === undefined || value === '' ? fallback : value;
}

function strOrNull(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  return value === undefined || value === '' ? null : value;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = env[key];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${key}: expected a number, got "${value}"`);
  }
  return parsed;
}

/** Non-negative number: 0 is meaningful ("disabled"), negatives are a config error. */
function nonNegative(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const parsed = num(env, key, fallback);
  if (parsed < 0) {
    throw new Error(`Invalid ${key}: expected a non-negative number, got "${parsed}"`);
  }
  return parsed;
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const value = env[key];
  if (value === undefined || value === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid ${key}: expected a boolean, got "${value}"`);
}

function enumValue<T extends string>(
  env: NodeJS.ProcessEnv,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = env[key];
  if (value === undefined || value === '') return fallback;
  const normalized = value.trim().toLowerCase();
  const hit = allowed.find((candidate) => candidate === normalized);
  if (!hit) {
    throw new Error(`Invalid ${key}: expected one of ${allowed.join('|')}, got "${value}"`);
  }
  return hit;
}

/**
 * Builds the configuration from `env`.
 * Throws a descriptive error on invalid values — the gateway must fail fast at startup.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  loadDotEnv(env);
  const logFileRaw = str(env, 'LOG_FILE', 'logs/gateway.jsonl');
  const logFile = ['none', 'off', 'false'].includes(logFileRaw.toLowerCase()) ? null : logFileRaw;
  return {
    port: num(env, 'PORT', 8080),
    clairBaseUrl: str(env, 'CLAIR_BASE_URL', 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    clairTimeoutMs: num(env, 'CLAIR_TIMEOUT_MS', 10_000),
    clairTextField: strOrNull(env, 'CLAIR_TEXT_FIELD'),
    clairResponseField: strOrNull(env, 'CLAIR_RESPONSE_FIELD'),
    llmProviderUrl: str(env, 'LLM_PROVIDER_URL', 'https://api.openai.com').replace(/\/+$/, ''),
    llmApiKey: strOrNull(env, 'LLM_API_KEY'),
    llmTimeoutMs: num(env, 'LLM_TIMEOUT_MS', 300_000),
    compressionMode: enumValue(env, 'COMPRESSION_MODE', ['low', 'medium', 'high'] as const, 'medium'),
    compressionEnabled: bool(env, 'COMPRESSION_ENABLED', true),
    failStrategy: enumValue(env, 'CLAIR_FAIL_STRATEGY', ['fail_open', 'fail_closed'] as const, 'fail_open'),
    sessionName: str(env, 'SESSION_NAME', 'clair-gateway'),
    logLevel: enumValue(env, 'LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, 'info'),
    logFile,
    bodyLimitMb: num(env, 'BODY_LIMIT_MB', 20),
    cacheTtlMs: nonNegative(env, 'CLAIR_CACHE_TTL_MS', 300_000),
    cacheMaxEntries: nonNegative(env, 'CLAIR_CACHE_MAX_ENTRIES', 500),
  };
}
