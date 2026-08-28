import { afterEach, describe, expect, it } from 'vitest';
import { ClairClient } from '../src/compressor.js';
import { ClairBadResponseError, ClairCompressionError, ClairUnavailableError } from '../src/errors.js';
import { estimateTokens } from '../src/tokens.js';
import { Logger } from '../src/logger.js';
import { startMockClair, type MockClairOptions, type MockServerHandle } from './helpers/mocks.js';
import { makeConfig } from './helpers/test-config.js';

const noopLog = new Logger('error', null);

describe('ClairClient — HTTP contract with the immutable CLAIR Base', () => {
  const open: MockServerHandle[] = [];

  afterEach(async () => {
    while (open.length) await open.pop()!.close();
  });

  async function start(options: MockClairOptions = {}): Promise<MockServerHandle> {
    const handle = await startMockClair(options);
    open.push(handle);
    return handle;
  }

  it('sends text, session and mode to POST /compress', async () => {
    const clair = await start();
    const client = new ClairClient(makeConfig({ clairBaseUrl: clair.url }), noopLog);
    await client.compress('Hello CLAIR');
    expect(clair.requests[0].path).toBe('/compress');
    expect(clair.requests[0].body).toEqual({
      text: 'Hello CLAIR',
      session: 'test-session',
      mode: 'medium',
    });
  });

  it('parses the canonical response shape with reported token counts', async () => {
    const clair = await start({
      response: { compressed: 'hll wrld', original_tokens: 1000, compressed_tokens: 650 },
    });
    const client = new ClairClient(makeConfig({ clairBaseUrl: clair.url }), noopLog);
    const result = await client.compress('Hello world');
    expect(result.text).toBe('hll wrld');
    expect(result.originalTokens).toBe(1000);
    expect(result.compressedTokens).toBe(650);
    expect(result.ratio).toBe(1.54);
    expect(result.reportedByClair).toBe(true);
  });

  it('parses alternative response shapes (data.compressed_text, tokens_before/after)', async () => {
    const clair = await start({
      rawBody: JSON.stringify({ data: { compressed_text: 'xyz', tokens_before: 10, tokens_after: 4 } }),
    });
    const client = new ClairClient(makeConfig({ clairBaseUrl: clair.url }), noopLog);
    const result = await client.compress('x y z w');
    expect(result.text).toBe('xyz');
    expect(result.originalTokens).toBe(10);
    expect(result.compressedTokens).toBe(4);
  });

  it('falls back to token estimation when CLAIR reports no counts', async () => {
    const clair = await start({ response: { compressed: 'ok' } });
    const client = new ClairClient(makeConfig({ clairBaseUrl: clair.url }), noopLog);
    const source = 'A reasonably long prompt to estimate tokens for';
    const result = await client.compress(source);
    expect(result.reportedByClair).toBe(false);
    expect(result.originalTokens).toBe(estimateTokens(source));
    expect(result.compressedTokens).toBe(estimateTokens('ok'));
  });

  it('supports custom field names (CLAIR_TEXT_FIELD / CLAIR_RESPONSE_FIELD)', async () => {
    const clair = await start({
      rawBody: JSON.stringify({ payload: { body: { text: 'deep' } } }),
    });
    const client = new ClairClient(
      makeConfig({
        clairBaseUrl: clair.url,
        clairTextField: 'prompt',
        clairResponseField: 'payload.body.text',
      }),
      noopLog,
    );
    const result = await client.compress('Hello');
    expect(clair.requests[0].body).toMatchObject({ prompt: 'Hello', session: 'test-session', mode: 'medium' });
    expect(result.text).toBe('deep');
  });

  it('HTTP 500 from CLAIR → ClairUnavailableError', async () => {
    const clair = await start({ status: 500 });
    const client = new ClairClient(makeConfig({ clairBaseUrl: clair.url }), noopLog);
    const err = await client.compress('Hello').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClairUnavailableError);
    expect(err).toBeInstanceOf(ClairCompressionError);
  });

  it('malformed JSON body → ClairBadResponseError', async () => {
    const clair = await start({ rawBody: '<html>gateway error</html>' });
    const client = new ClairClient(makeConfig({ clairBaseUrl: clair.url }), noopLog);
    await expect(client.compress('Hello')).rejects.toBeInstanceOf(ClairBadResponseError);
  });

  it('response without recognizable compressed text → ClairBadResponseError', async () => {
    const clair = await start({ response: { nothing: 'useful' } });
    const client = new ClairClient(makeConfig({ clairBaseUrl: clair.url }), noopLog);
    await expect(client.compress('Hello')).rejects.toBeInstanceOf(ClairBadResponseError);
  });

  it('CLAIR timeout → ClairUnavailableError', async () => {
    const clair = await start({ delayMs: 600 });
    const client = new ClairClient(makeConfig({ clairBaseUrl: clair.url, clairTimeoutMs: 120 }), noopLog);
    const err = await client.compress('Hello').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClairUnavailableError);
    expect(err).toBeInstanceOf(ClairCompressionError);
  });
});
