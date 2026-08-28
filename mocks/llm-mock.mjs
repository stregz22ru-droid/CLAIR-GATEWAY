// Standalone mock of an OpenAI-compatible LLM API (demo-only, zero deps).
// Serves POST /v1/chat/completions (JSON + SSE streaming) and GET /v1/models.
//
//   node mocks/llm-mock.mjs            # listens on :4000
//   LLM_MOCK_PORT=4001 node mocks/llm-mock.mjs
import http from 'node:http';

const PORT = Number(process.env.LLM_MOCK_PORT ?? 4000);
const estimateTokens = (text) => Math.max(1, Math.ceil((text ?? '').length / 4));

function collectText(body) {
  let out = '';
  for (const message of body?.messages ?? []) {
    if (typeof message?.content === 'string') out += message.content;
    else if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (part?.type === 'text' && typeof part.text === 'string') out += part.text;
      }
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', (chunk) => {
    data += chunk.toString('utf8');
  });
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(data);
    } catch {
      /* ignore malformed body */
    }

    if (req.method === 'GET' && (req.url ?? '').startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'gpt-4o-mini', object: 'model', owned_by: 'llm-mock' },
            { id: 'gpt-4o', object: 'model', owned_by: 'llm-mock' },
          ],
        }),
      );
      return;
    }

    if (req.method !== 'POST' || !(req.url ?? '').startsWith('/v1/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid URL (llm-mock)', type: 'invalid_request_error' } }));
      return;
    }

    const promptText = collectText(body);
    const lastUser = [...(body?.messages ?? [])].reverse().find((m) => m?.role === 'user');
    const lastText = typeof lastUser?.content === 'string' ? lastUser.content : '';
    const answer = `Mock LLM answer. You asked: "${lastText.slice(0, 80)}"`;

    // SSE streaming mode
    if (body?.stream === true) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const words = answer.split(' ');
      for (let i = 0; i < words.length; i++) {
        const event = {
          id: 'chatcmpl-mock',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body?.model ?? 'mock-gpt',
          choices: [{ index: 0, delta: { content: (i ? ' ' : '') + words[i] }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Regular JSON mode
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body?.model ?? 'mock-gpt',
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: estimateTokens(promptText),
          completion_tokens: estimateTokens(answer),
          total_tokens: estimateTokens(promptText) + estimateTokens(answer),
        },
      }),
    );
  });
});

server.listen(PORT, () => {
  console.log(`[llm-mock] listening on http://127.0.0.1:${PORT} (POST /v1/chat/completions)`);
});
