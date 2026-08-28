import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CapturedRequest {
  method: string;
  path: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export interface MockServerHandle {
  url: string;
  port: number;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

function listenOnEphemeralPort(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): () => Promise<void> {
  return () =>
    new Promise((resolve, reject) => {
      server.closeAllConnections?.();
      server.close((err) => (err ? reject(err) : resolve()));
    });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    req.on('end', () => resolve(data));
  });
}

// ─────────────────────────── CLAIR Base mock ───────────────────────────────

export interface MockClairOptions {
  /** HTTP status to return (>= 400 emulates a failing service). */
  status?: number;
  /** Static JSON response body (wins over the default computed payload). */
  response?: unknown;
  /** Raw response body — used to emulate malformed JSON. */
  rawBody?: string;
  /** Delay before responding, ms (to test the client timeout). */
  delayMs?: number;
  /** Transform applied to the incoming text. Default: strip vowels. */
  transform?: (text: string) => string;
}

/** Deterministic pseudo-compression used by default: strips vowels. */
export const stripVowels = (text: string): string =>
  text
    .replace(/[aeiouAEIOU]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export async function startMockClair(options: MockClairOptions = {}): Promise<MockServerHandle> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    requests.push({ method: req.method ?? 'GET', path: req.url, headers: req.headers, body });

    const respond = (): void => {
      if (options.status !== undefined && options.status >= 400) {
        res.writeHead(options.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `mock clair failure (HTTP ${options.status})` }));
        return;
      }
      if (options.rawBody !== undefined) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(options.rawBody);
        return;
      }
      const text =
        typeof (body as { text?: unknown } | null)?.text === 'string'
          ? (body as { text: string }).text
          : '';
      const compressed = options.transform ? options.transform(text) : stripVowels(text);
      const payload = options.response ?? { compressed };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (options.delayMs) setTimeout(respond, options.delayMs);
    else respond();
  });
  const port = await listenOnEphemeralPort(server);
  return { url: `http://127.0.0.1:${port}`, port, requests, close: closeServer(server) };
}

// ────────────────────────────── LLM mock ───────────────────────────────────

export interface MockLlmOptions {
  /** Static or computed JSON response for non-streaming requests. */
  response?: unknown | ((req: CapturedRequest) => unknown);
  /** HTTP status for the JSON response. */
  status?: number;
  /** Delay before responding, ms. */
  delayMs?: number;
  /** Content chunks for SSE streaming responses. */
  sseChunks?: string[];
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function collectText(body: { messages?: { content?: unknown }[] } | null): string {
  if (!body || !Array.isArray(body.messages)) return '';
  let out = '';
  for (const message of body.messages) {
    if (typeof message?.content === 'string') {
      out += message.content;
    } else if (Array.isArray(message?.content)) {
      for (const part of message.content as { type?: string; text?: string }[]) {
        if (part?.type === 'text' && typeof part.text === 'string') out += part.text;
      }
    }
  }
  return out;
}

export async function startMockLlm(options: MockLlmOptions = {}): Promise<MockServerHandle> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    requests.push({ method: req.method ?? 'GET', path: req.url, headers: req.headers, body });

    const respond = (): void => {
      if ((req.url ?? '').startsWith('/v1/models') && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'mock-gpt', object: 'model', owned_by: 'mock' }],
          }),
        );
        return;
      }
      if (!((req.url ?? '').startsWith('/v1/chat/completions') && req.method === 'POST')) {
        // Behave like a real provider: unknown routes get a 404.
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid URL (mock LLM)', type: 'invalid_request_error' } }));
        return;
      }

      const typedBody = body as { stream?: boolean; model?: string } | null;
      if (typedBody && typeof typedBody === 'object' && typedBody.stream === true) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const chunks = options.sseChunks ?? ['Mock ', 'streamed ', 'answer'];
        for (const chunk of chunks) {
          const event = {
            id: 'chatcmpl-mock',
            object: 'chat.completion.chunk',
            created: 1,
            model: typedBody?.model ?? 'mock-gpt',
            choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const promptText = collectText(typedBody);
      const defaultResponse = {
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: 1,
        model: typedBody?.model ?? 'mock-gpt',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Mock LLM answer.' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: estimateTokens(promptText),
          completion_tokens: 9,
          total_tokens: estimateTokens(promptText) + 9,
        },
      };
      const last = requests[requests.length - 1];
      const payload =
        typeof options.response === 'function' ? options.response(last) : (options.response ?? defaultResponse);
      res.writeHead(options.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (options.delayMs) setTimeout(respond, options.delayMs);
    else respond();
  });
  const port = await listenOnEphemeralPort(server);
  return { url: `http://127.0.0.1:${port}`, port, requests, close: closeServer(server) };
}
