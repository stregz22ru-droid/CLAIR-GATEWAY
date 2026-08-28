import { Logger, type OperationRecord } from '../../src/logger.js';

/**
 * Logger for tests: silences console output and records every operation
 * event in memory so tests can assert on the JSONL fields.
 */
export class MemoryLogger extends Logger {
  readonly ops: OperationRecord[] = [];

  constructor() {
    super('error', null);
  }

  override operation(record: OperationRecord): void {
    this.ops.push(record);
  }
}
