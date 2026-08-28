import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/main.js';
import { Logger } from '../src/logger.js';
import { MemoryLogger } from './helpers/memory-logger.js';
import { startMockClair, startMockLlm, stripVowels, type MockServerHandle } from './helpers/mocks.js';
import { chatBody, makeConfig } from './helpers/test-config.js';

describe('Scenario 7: A/B testing — one request compressed, one bypassed', () => {
  const open: MockServerHandle[] = [];

  afterEach(async () => {
    while (open.length) await open.pop()!.close();
  });

  it('two identical requests take different paths through the gateway', async () => {
    const clair = await startMockClair();
    const llm = await startMockLlm();
    open.push(clair, llm);
    const log = new MemoryLogger();
    const app = buildApp({
      config: makeConfig({ clairBaseUrl: clair.url, llmProviderUrl: llm.url }),
      logger: log,
    });
    const content = 'Compare branch A with compression against branch B without it';
    const body = chatBody(content);

    const withCompression = await request(app).post('/v1/chat/completions').send(body);
    const withoutCompression = await request(app)
      .post('/v1/chat/completions')
      .set('X-Clair-Compress', 'false')
      .send(body);

    expect(withCompression.status).toBe(200);
    expect(withoutCompression.status).toBe(200);

    const branchA = (llm.requests[0].body as { messages: { content: string }[] }).messages[0].content;
    const branchB = (llm.requests[1].body as { messages: { content: string }[] }).messages[0].content;
    expect(branchA).toBe(stripVowels(content)); // branch A: compressed
    expect(branchB).toBe(content); // branch B: original
    expect(clair.requests.length).toBe(1);

    const opA = log.ops.at(-2)!;
    const opB = log.ops.at(-1)!;
    expect(opA.compression_enabled).toBe(true);
    expect(opA.saved_tokens).toBeGreaterThan(0);
    expect(opB.compression_enabled).toBe(false);
    expect(opB.saved_tokens).toBe(0);
    expect(opB.note).toBe('compression_disabled_by_header');
  });

  it('every operation is appended to the JSONL log in the spec format', async () => {
    const clair = await startMockClair({
      response: { compressed: 'tiny', original_tokens: 1000, compressed_tokens: 650 },
    });
    const llm = await startMockLlm();
    open.push(clair, llm);

    const file = path.join(os.tmpdir(), `clair-gateway-${randomUUID()}.jsonl`);
    const logger = new Logger('error', file);
    const app = buildApp({
      config: makeConfig({ clairBaseUrl: clair.url, llmProviderUrl: llm.url, logFile: file }),
      logger,
    });
    try {
      await request(app).post('/v1/chat/completions').send(chatBody('A long prompt for the JSONL log check'));
    } finally {
      await logger.close();
    }

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const record = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    for (const key of [
      'timestamp',
      'session',
      'original_tokens',
      'compressed_tokens',
      'saved_tokens',
      'compression_ratio',
      'llm_response_tokens',
      'latency_ms',
    ]) {
      expect(record, `missing field: ${key}`).toHaveProperty(key);
    }
    expect(record.original_tokens).toBe(1000);
    expect(record.compressed_tokens).toBe(650);
    expect(record.saved_tokens).toBe(350);
    expect(record.compression_ratio).toBe(1.54);
    expect(record.session).toBe('test-session');
    expect(typeof record.latency_ms).toBe('number');
    fs.rmSync(file, { force: true });
  });
});
