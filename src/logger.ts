import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * One entry of the JSONL operation log. The first fields are mandated by the
 * CLAIR Gateway spec; the rest are useful diagnostics.
 */
export interface OperationRecord {
  timestamp: string;
  session: string;
  request_id?: string;
  route?: string;
  model?: string;
  compression_enabled?: boolean;
  stream?: boolean;
  original_tokens: number;
  compressed_tokens: number;
  saved_tokens: number;
  compression_ratio: number;
  llm_response_tokens: number | null;
  latency_ms: number;
  status?: number;
  note?: string | null;
  [key: string]: unknown;
}

/**
 * Structured logger: human-facing events go to stdout as JSON lines,
 * operation records are appended to the JSONL file (always, regardless of
 * the console verbosity level) so the file is a complete audit trail.
 */
export class Logger {
  private readonly stream: fs.WriteStream | null;

  constructor(
    private readonly level: LogLevel = 'info',
    logFile?: string | null,
  ) {
    if (logFile) {
      const resolved = path.resolve(logFile);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      this.stream = fs.createWriteStream(resolved, { flags: 'a' });
      this.stream.on('error', (err: unknown) => {
        this.emit('error', 'log file write failed', { error: String(err) });
      });
    } else {
      this.stream = null;
    }
  }

  private enabled(level: LogLevel): boolean {
    return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[this.level];
  }

  private emit(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
    process.stdout.write(line + '\n');
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    if (this.enabled('debug')) this.emit('debug', msg, fields);
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    if (this.enabled('info')) this.emit('info', msg, fields);
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    if (this.enabled('warn')) this.emit('warn', msg, fields);
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    if (this.enabled('error')) this.emit('error', msg, fields);
  }

  /** Appends one operation record to the JSONL log file and mirrors it to stdout. */
  operation(record: OperationRecord): void {
    const line = JSON.stringify(record);
    if (this.stream) this.stream.write(line + '\n');
    if (this.enabled('info')) this.emit('info', 'operation', { ...record });
  }

  /** Flushes and closes the log file (used by graceful shutdown and tests). */
  async close(): Promise<void> {
    const stream = this.stream;
    if (!stream) return;
    await new Promise<void>((resolve) => stream.end(() => resolve()));
  }
}
