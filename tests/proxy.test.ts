import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/main.js';
import { MemoryLogger } from './helpers/memory-logger.js';
import { startMockClair, startMockLlm, stripVowels, type MockServerHandle } from './helpers/mocks.js';
import { chatBody, makeConfig } from './helpers/test-config.js';

/**
 * Integration tests for spec scenarios 1–6 (scenario 7 — A/B — lives in ab.test.ts).
 * Both upstreams are in-process HTTP mocks: no real CLAIR Base or LLM needed.
 */
describe('CLAIR Gateway — proxy integration (spec scenarios 1–6)', () => {
  let clair: MockServerHandle;
  let llm: MockServerHandle;
  let log: MemoryLogger;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    clair = await startMockClair();
    llm = await startMockLlm();
    log = new MemoryLogger();
    app = buildApp({ config: makeConfig({ clairBaseUrl: clair.url, llmProviderUrl: llm.url }), logger: log });
  });

  afterEach(async () => {
    await Promise.all([clair.close(), llm.close()]);
  });

  it('Scenario 1: basic proxy round-trip preserves the OpenAI contract', async () => {
    const res = await request(app).post('/v1/chat/completions').send(chatBody('Hello world'));
    expect(res.status).toBe(200);
    expect(res.body.object).toBe('chat.completion');
    expect(res.body.choices[0].message.content).toBe('Mock LLM answer.');
    // The configured key is sent to the upstream LLM as a Bearer token.
    expect(llm.requests[0].headers.authorization).toBe('Bearer test-key');
  });

  it('Scenario 2: compression enabled — the prompt is compressed before the LLM', async () => {
    const content = 'The quick brown fox jumps over the lazy dog';
    const res = await request(app).post('/v1/chat/completions').send(chatBody(content));
    expect(res.status).toBe(200);
    const upstreamBody = llm.requests[0].body as { messages: { content: string }[] };
    expect(upstreamBody.messages[0].content).toBe(stripVowels(content));
    expect(upstreamBody.messages[0].content.length).toBeLessThan(content.length);
    const op = log.ops.at(-1)!;
    expect(op.compression_enabled).toBe(true);
    expect(op.saved_tokens).toBeGreaterThan(0);
    expect(op.compression_ratio).toBeGreaterThan(1);
    // CLAIR request contract: session and mode are passed.
    expect(clair.requests[0].body).toMatchObject({ session: 'test-session', mode: 'medium' });
  });

  it('Scenario 2b: the log carries the exact numbers reported by CLAIR (1000→650, saved 350, ratio 1.54)', async () => {
    const clairFixed = await startMockClair({
      response: { compressed: 'compressed prompt', original_tokens: 1000, compressed_tokens: 650 },
    });
    const llm2 = await startMockLlm();
    const log2 = new MemoryLogger();
    const app2 = buildApp({
      config: makeConfig({ clairBaseUrl: clairFixed.url, llmProviderUrl: llm2.url }),
      logger: log2,
    });
    try {
      const res = await request(app2).post('/v1/chat/completions').send(chatBody('A fairly long original prompt'));
      expect(res.status).toBe(200);
      expect((llm2.requests[0].body as { messages: { content: string }[] }).messages[0].content).toBe(
        'compressed prompt',
      );
      const op = log2.ops.at(-1)!;
      expect(op.original_tokens).toBe(1000);
      expect(op.compressed_tokens).toBe(650);
      expect(op.saved_tokens).toBe(350);
      expect(op.compression_ratio).toBe(1.54);
      expect(op.llm_response_tokens).toBeGreaterThan(0); // taken from the LLM `usage`
    } finally {
      await Promise.all([clairFixed.close(), llm2.close()]);
    }
  });

  it('Scenario 3: COMPRESSION_ENABLED=false — the prompt goes through as is', async () => {
    const log3 = new MemoryLogger();
    const app3 = buildApp({
      config: makeConfig({ clairBaseUrl: clair.url, llmProviderUrl: llm.url, compressionEnabled: false }),
      logger: log3,
    });
    const res = await request(app3).post('/v1/chat/completions').send(chatBody('Keep me intact'));
    expect(res.status).toBe(200);
    expect((llm.requests[0].body as { messages: { content: string }[] }).messages[0].content).toBe(
      'Keep me intact',
    );
    expect(clair.requests.length).toBe(0);
    const op = log3.ops.at(-1)!;
    expect(op.compression_enabled).toBe(false);
    expect(op.saved_tokens).toBe(0);
    expect(op.note).toBe('compression_disabled_by_config');
  });

  it('Scenario 4: header X-Clair-Compress: false bypasses compression per request', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('X-Clair-Compress', 'false')
      .send(chatBody('Do not touch this'));
    expect(res.status).toBe(200);
    expect((llm.requests[0].body as { messages: { content: string }[] }).messages[0].content).toBe(
      'Do not touch this',
    );
    expect(clair.requests.length).toBe(0);
    expect(log.ops.at(-1)!.compression_enabled).toBe(false);
    expect(log.ops.at(-1)!.note).toBe('compression_disabled_by_header');
  });

  it('Scenario 4b: header X-Clair-Compress: true re-enables compression disabled by config', async () => {
    const app4 = buildApp({
      config: makeConfig({ clairBaseUrl: clair.url, llmProviderUrl: llm.url, compressionEnabled: false }),
      logger: log,
    });
    const res = await request(app4)
      .post('/v1/chat/completions')
      .set('X-Clair-Compress', 'true')
      .send(chatBody('Compress me please'));
    expect(res.status).toBe(200);
    expect((llm.requests[0].body as { messages: { content: string }[] }).messages[0].content).toBe(
      stripVowels('Compress me please'),
    );
  });

  describe('Scenario 5: CLAIR Base unavailable', () => {
    it('fail_open (default): the request goes to the LLM uncompressed', async () => {
      const dead = await startMockClair();
      const deadUrl = dead.url;
      await dead.close(); // the port is now closed → connection refused

      const log5 = new MemoryLogger();
      const app5 = buildApp({
        config: makeConfig({ clairBaseUrl: deadUrl, llmProviderUrl: llm.url }),
        logger: log5,
      });
      const content = 'Original untouched prompt';
      const res = await request(app5).post('/v1/chat/completions').send(chatBody(content));
      expect(res.status).toBe(200);
      expect(res.body.choices[0].message.content).toBe('Mock LLM answer.');
      expect((llm.requests[0].body as { messages: { content: string }[] }).messages[0].content).toBe(content);
      const op = log5.ops.at(-1)!;
      expect(op.note).toBe('clair_unavailable_fail_open');
      expect(op.saved_tokens).toBe(0);
    });

    it('fail_closed: the gateway answers 503 in the OpenAI error format', async () => {
      const dead = await startMockClair();
      const deadUrl = dead.url;
      await dead.close();

      const app6 = buildApp({
        config: makeConfig({ clairBaseUrl: deadUrl, llmProviderUrl: llm.url, failStrategy: 'fail_closed' }),
        logger: log,
      });
      const res = await request(app6).post('/v1/chat/completions').send(chatBody('Will not pass'));
      expect(res.status).toBe(503);
      expect(res.body.error.type).toBe('clair_gateway_error');
      expect(res.body.error.code).toBe('clair_unavailable');
      expect(typeof res.body.error.message).toBe('string');
      expect(llm.requests.length).toBe(0);
    });

    it('a timing-out CLAIR is treated as unavailable (fail_open)', async () => {
      const slow = await startMockClair({ delayMs: 500 });
      const app7 = buildApp({
        config: makeConfig({ clairBaseUrl: slow.url, llmProviderUrl: llm.url, clairTimeoutMs: 100 }),
        logger: log,
      });
      const res = await request(app7).post('/v1/chat/completions').send(chatBody('Patience test'));
      expect(res.status).toBe(200);
      expect((llm.requests[0].body as { messages: { content: string }[] }).messages[0].content).toBe(
        'Patience test',
      );
      expect(log.ops.at(-1)!.note).toBe('clair_unavailable_fail_open');
      await slow.close();
    });
  });

  describe('Scenario 6: invalid requests → 400 in the OpenAI error format', () => {
    const cases: [string, object][] = [
      ['missing model', { messages: [{ role: 'user', content: 'hi' }] }],
      ['empty messages', { model: 'gpt-4o-mini', messages: [] }],
      ['message without content', { model: 'gpt-4o-mini', messages: [{ role: 'user' }] }],
    ];
    for (const [name, body] of cases) {
      it(name, async () => {
        const res = await request(app).post('/v1/chat/completions').send(body);
        expect(res.status).toBe(400);
        expect(res.body.error.type).toBe('invalid_request_error');
        expect(typeof res.body.error.message).toBe('string');
      });
    }

    it('body is not an object', async () => {
      const res = await request(app).post('/v1/chat/completions').send('just a string');
      expect(res.status).toBe(400);
      expect(res.body.error.type).toBe('invalid_request_error');
    });

    it('malformed JSON body', async () => {
      const res = await request(app)
        .post('/v1/chat/completions')
        .set('content-type', 'application/json')
        .send('{"model":');
      expect(res.status).toBe(400);
      expect(res.body.error.type).toBe('invalid_request_error');
    });
  });

  it('upstream LLM errors are passed through untouched', async () => {
    const errLlm = await startMockLlm({
      status: 429,
      response: { error: { message: 'Too many requests', type: 'rate_limit_error', code: 'rate_limit' } },
    });
    const app8 = buildApp({
      config: makeConfig({ clairBaseUrl: clair.url, llmProviderUrl: errLlm.url }),
      logger: log,
    });
    try {
      const res = await request(app8).post('/v1/chat/completions').send(chatBody('Hello'));
      expect(res.status).toBe(429);
      expect(res.body.error.message).toBe('Too many requests');
      expect(res.body.error.code).toBe('rate_limit');
    } finally {
      await errLlm.close();
    }
  });

  it('stream: true — SSE is piped through chunk-by-chunk with a compressed request', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .send({ ...chatBody('Hello world'), stream: true });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('Mock ');
    expect(res.text).toContain('data: [DONE]');
    const upstreamBody = llm.requests[0].body as { stream: boolean; messages: { content: string }[] };
    expect(upstreamBody.stream).toBe(true);
    expect(upstreamBody.messages[0].content).toBe(stripVowels('Hello world'));
  });

  it('multimodal content: text parts are compressed, non-text parts stay untouched', async () => {
    const body = {
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this picture' },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
          ],
        },
      ],
    };
    const res = await request(app).post('/v1/chat/completions').send(body);
    expect(res.status).toBe(200);
    const sent = (
      llm.requests[0].body as { messages: { content: { type: string; text?: string; image_url?: unknown }[] }[] }
    ).messages[0].content;
    expect(sent[0].text).toBe(stripVowels('Describe this picture'));
    expect(sent[1].image_url).toEqual({ url: 'https://example.com/cat.png' });
  });

  it('no-gain guard: when compression does not shorten the text, the original is sent', async () => {
    const clairIdentity = await startMockClair({ transform: (t) => t });
    const log9 = new MemoryLogger();
    const app9 = buildApp({
      config: makeConfig({ clairBaseUrl: clairIdentity.url, llmProviderUrl: llm.url }),
      logger: log9,
    });
    try {
      const res = await request(app9).post('/v1/chat/completions').send(chatBody('short'));
      expect(res.status).toBe(200);
      expect((llm.requests[0].body as { messages: { content: string }[] }).messages[0].content).toBe('short');
      expect(log9.ops.at(-1)!.note).toBe('compression_no_gain');
      expect(log9.ops.at(-1)!.saved_tokens).toBe(0);
    } finally {
      await clairIdentity.close();
    }
  });

  it('GET /v1/models is proxied without compression', async () => {
    const res = await request(app).get('/v1/models');
    expect(res.status).toBe(200);
    expect(res.body.data[0].id).toBe('mock-gpt');
    expect(clair.requests.length).toBe(0);
  });

  it('routes outside /v1 → 404 in the OpenAI format; /health works', async () => {
    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');
    const missing = await request(app).post('/chat/completions').send(chatBody('Hello world'));
    expect(missing.status).toBe(404);
    expect(missing.body.error.type).toBe('invalid_request_error');
    expect(missing.body.error.code).toBe('not_found');
  });

  it('the agent Authorization header is forwarded when LLM_API_KEY is not set', async () => {
    const app10 = buildApp({
      config: makeConfig({ clairBaseUrl: clair.url, llmProviderUrl: llm.url, llmApiKey: null }),
      logger: log,
    });
    await request(app10)
      .post('/v1/chat/completions')
      .set('authorization', 'Bearer agent-own-key')
      .send(chatBody('Hello world'));
    expect(llm.requests[0].headers.authorization).toBe('Bearer agent-own-key');
  });
});
