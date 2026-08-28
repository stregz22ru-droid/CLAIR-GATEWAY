import type { Config } from '../../src/config.js';

/** Full valid config with overridable defaults for tests. */
export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    clairBaseUrl: 'http://127.0.0.1:1', // overridden in nearly every test
    clairTimeoutMs: 2_000,
    clairTextField: null,
    clairResponseField: null,
    llmProviderUrl: 'http://127.0.0.1:1',
    llmApiKey: 'test-key',
    llmTimeoutMs: 10_000,
    compressionMode: 'medium',
    compressionEnabled: true,
    failStrategy: 'fail_open',
    sessionName: 'test-session',
    logLevel: 'error',
    logFile: null,
    bodyLimitMb: 5,
    cacheTtlMs: 300_000,
    cacheMaxEntries: 500,
    ...overrides,
  };
}

export const chatBody = (content: string, model = 'gpt-4o-mini') => ({
  model,
  messages: [{ role: 'user', content }],
});
