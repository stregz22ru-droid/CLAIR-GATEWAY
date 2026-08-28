import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/main.js';
import { PromptCache } from '../src/cache.js';
import { MemoryLogger } from './helpers/memory-logger.js';
import { startMockClair, startMockLlm, stripVowels, type MockServerHandle } from './helpers/mocks.js';
import { chatBody, makeConfig } from './helpers/test-config.js';

// ─────────────────────────── Unit: PromptCache ──────────────────────────────

describe('PromptCache (unit)', () => {
  it('keys are SHA-256 content addresses: stable and collision-free', () => {
    expect(PromptCache.keyFor('abc')).toBe(PromptCache.keyFor('abc'));
    expect(PromptCache.keyFor('abc')).not.toBe(PromptCache.keyFor('abd'));
    expect(PromptCache.keyFor('')).toHaveLength(64);
  });

  it('set/get round-trip preserves text and token counts', () => {
    const cache = new PromptCache(60_000, 10);
    const key = PromptCache.keyFor('prompt');
    cache.set(key, { text: 'compressed', originalTokens: 100, compressedTokens: 60 });
    expect(cache.get(key)).toEqual({ text: 'compressed', originalTokens: 100, compressedTokens: 60 });
  });

  it('evicts the least recently used entry when maxEntries is reached', () => {
    const cache = new PromptCache(60_000, 2);
    const a = PromptCache.keyFor('a');
    const b = PromptCache.keyFor('b');
    const c = PromptCache.keyFor('c');
    cache.set(a, { text: 'A', originalTokens: 1, compressedTokens: 1 });
    cache.set(b, { text: 'B', originalTokens: 1, compressedTokens: 1 });
    // Touching `a` makes `b` the LRU victim.
    cache.get(a);
    cache.set(c, { text: 'C', originalTokens: 1, compressedTokens: 1 });
    expect(cache.get(a)).not.toBeNull();
    expect(cache.get(b)).toBeNull();
    expect(cache.get(c)).not.toBeNull();
    expect(cache.stats.evictions).toBe(1);
    expect(cache.size).toBe(2);
  });

  it('expired entries are dropped and counted as misses (TTL)', async () => {
    const cache = new PromptCache(20, 10);
    const key = PromptCache.keyFor('ttl-text');
    cache.set(key, { text: 'x', originalTokens: 1, compressedTokens: 1 });
    expect(cache.get(key)).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cache.get(key)).toBeNull();
    expect(cache.stats.misses).toBe(1);
  });

  it('maxEntries=0 disables storing entirely', () => {
    const cache = new PromptCache(60_000, 0);
    const key = PromptCache.keyFor('anything');
    cache.set(key, { text: 'x', originalTokens: 1, compressedTokens: 1 });
    expect(cache.get(key)).toBeNull();
    expect(cache.size).toBe(0);
  });
});

// ─────────────── Integration: cache in the request pipeline ─────────────────

describe('Prompt cache — proxy integration', () => {
  let clair: MockServerHandle;
  let llm: MockServerHandle;
  let log: MemoryLogger;

  beforeEach(async () => {
    clair = await startMockClair();
    llm = await startMockLlm();
    log = new MemoryLogger();
  });

  afterEach(async () => {
    await Promise.all([clair.close(), llm.close()]);
  });

  const buildCachedApp = (overrides: Parameters<typeof makeConfig>[0] = {}) =>
    buildApp({
      config: makeConfig({ clairBaseUrl: clair.url, llmProviderUrl: llm.url, ...overrides }),
      logger: log,
    });

  it('a repeated prompt is served from the cache: CLAIR is hit exactly once', async () => {
    const app = buildCachedApp();
    const body = chatBody('The quick brown fox jumps over the lazy dog');

    const first = await request(app).post('/v1/chat/completions').send(body);
    const second = await request(app).post('/v1/chat/completions').send(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers['x-clair-cache']).toBe('MISS');
    expect(second.headers['x-clair-cache']).toBe('HIT');
    // CLAIR saw the text only once, but both requests were compressed.
    expect(clair.requests).toHaveLength(1);
    for (const captured of llm.requests) {
      expect((captured.body as { messages: { content: string }[] }).messages[0].content).toBe(
        stripVowels('The quick brown fox jumps over the lazy dog'),
      );
    }
    // JSONL: fresh compression then a full cache replay with identical numbers.
    const [op1, op2] = log.ops.slice(-2);
    expect(op1.cache_hits).toBe(0);
    expect(op1.cache_misses).toBe(1);
    expect(op2.cache_hits).toBe(1);
    expect(op2.cache_misses).toBe(0);
    expect(op2.saved_tokens).toBe(op1.saved_tokens);
    expect(op2.compression_ratio).toBe(op1.compression_ratio);
  });

  it('shared system prompt + new user message yields PARTIAL and only compresses the new text', async () => {
    const app = buildCachedApp();
    const system = { role: 'system', content: 'You are a terse assistant. Answer in five words or fewer.' };

    await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4o-mini', messages: [system, { role: 'user', content: 'What is TypeScript?' }] });
    await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4o-mini', messages: [system, { role: 'user', content: 'What is Node.js?' }] });

    expect(clair.requests).toHaveLength(3); // system + first user, then only the second user
    expect(clair.requests.at(-1)!.body).toMatchObject({ text: 'What is Node.js?' });
    const op2 = log.ops.at(-1)!;
    expect(op2.cache_hits).toBe(1);
    expect(op2.cache_misses).toBe(1);
    expect(log.ops.at(-1)!.status).toBe(200);
    expect((llm.requests.at(-1)!.headers as Record<string, unknown>)['x-clair-cache']).toBeUndefined(); // not forwarded upstream
  });

  it('PARTIAL is reported on the response header', async () => {
    const app = buildCachedApp();
    const system = { role: 'system', content: 'You are a terse assistant. Answer in five words or fewer.' };
    const post = (user: string) =>
      request(app).post('/v1/chat/completions').send({ model: 'gpt-4o-mini', messages: [system, { role: 'user', content: user }] });

    await post('First question about testing?');
    const second = await post('Second question about caching?');
    expect(second.headers['x-clair-cache']).toBe('PARTIAL');
    const third = await post('First question about testing?'); // both texts cached now
    expect(third.headers['x-clair-cache']).toBe('HIT');
    expect(clair.requests).toHaveLength(3); // 2 in request 1, 1 in request 2, 0 in request 3
  });

  it('no-gain compressions are not cached — CLAIR is consulted again', async () => {
    // A "compressor" that never shortens anything → degradation guard keeps the original.
    const noopClair = await startMockClair({ transform: (text) => text });
    const app = buildApp({
      config: makeConfig({ clairBaseUrl: noopClair.url, llmProviderUrl: llm.url }),
      logger: log,
    });
    try {
      const body = chatBody('Totally incompressible text');
      await request(app).post('/v1/chat/completions').send(body);
      await request(app).post('/v1/chat/completions').send(body);
      expect(noopClair.requests).toHaveLength(2);
      // Per-request counters: the second request missed the (empty) cache once.
      expect(log.ops.at(-1)!.cache_hits).toBe(0);
      expect(log.ops.at(-1)!.cache_misses).toBe(1);
      expect(log.ops.at(-1)!.note).toBe('compression_no_gain');
    } finally {
      await noopClair.close();
    }
  });

  it('fail_open responses are not cached — the next request retries CLAIR', async () => {
    const failingClair = await startMockClair({ status: 500 });
    const app = buildApp({
      config: makeConfig({ clairBaseUrl: failingClair.url, llmProviderUrl: llm.url }),
      logger: log,
    });
    try {
      const body = chatBody('Some agent prompt that will fail to compress');
      await request(app).post('/v1/chat/completions').send(body); // CLAIR 500 → fail_open
      await request(app).post('/v1/chat/completions').send(body);
      expect(failingClair.requests).toHaveLength(2); // retried, not cached
      expect(log.ops.at(-1)!.note).toBe('clair_unavailable_fail_open');
      expect(log.ops.at(-1)!.cache_hits).toBe(0);
    } finally {
      await failingClair.close();
    }
  });

  it('compression bypass via header reports BYPASS and stores nothing', async () => {
    const app = buildCachedApp();
    const body = chatBody('Bypass me please, dear gateway');
    await request(app).post('/v1/chat/completions').set('X-Clair-Compress', 'false').send(body);
    expect(log.ops.at(-1)!.note).toBe('compression_disabled_by_header');
    // Now a normal request: it must be a MISS, meaning the bypassed text was not cached.
    const res = await request(app).post('/v1/chat/completions').send(body);
    expect(res.headers['x-clair-cache']).toBe('MISS');
    // The bypassed request never touched CLAIR; only the second one did.
    expect(clair.requests).toHaveLength(1);
  });

  it('TTL expiry re-compresses after the entry lifetime', async () => {
    const app = buildCachedApp({ cacheTtlMs: 25 });
    const body = chatBody('Expiring soon: the quick brown fox');
    await request(app).post('/v1/chat/completions').send(body);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const res = await request(app).post('/v1/chat/completions').send(body);
    expect(res.headers['x-clair-cache']).toBe('MISS');
    expect(clair.requests).toHaveLength(2);
  });

  it('cache disabled via CLAIR_CACHE_MAX_ENTRIES=0 behaves like before', async () => {
    const app = buildCachedApp({ cacheMaxEntries: 0 });
    const body = chatBody('Disabled cache should not deduplicate');
    await request(app).post('/v1/chat/completions').send(body);
    await request(app).post('/v1/chat/completions').send(body);
    expect(clair.requests).toHaveLength(2);
    // Documented semantics: counters stay 0/0 when the cache is disabled.
    expect(log.ops.at(-1)!.cache_hits).toBe(0);
    expect(log.ops.at(-1)!.cache_misses).toBe(0);
  });
});
