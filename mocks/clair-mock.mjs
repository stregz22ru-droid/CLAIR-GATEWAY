// Standalone mock of the immutable CLAIR Base service (demo-only, zero deps).
// Emulates POST /compress with a deterministic pseudo-compression:
// collapses whitespace and strips vowels (~30-35% of characters removed).
//
//   node mocks/clair-mock.mjs          # listens on :3000
//   CLAIR_MOCK_PORT=3001 node mocks/clair-mock.mjs
import http from 'node:http';

const PORT = Number(process.env.CLAIR_MOCK_PORT ?? 3000);
const estimateTokens = (text) => Math.max(1, Math.ceil((text ?? '').length / 4));

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'clair-mock' }));
    return;
  }
  if (req.method !== 'POST' || !(req.url ?? '').startsWith('/compress')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found (clair-mock serves POST /compress)' }));
    return;
  }
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
    const text = typeof body.text === 'string' ? body.text : '';
    const compressed = text.replace(/[aeiou]/gi, '').replace(/\s+/g, ' ').trim();
    const payload = {
      compressed,
      original_tokens: estimateTokens(text),
      compressed_tokens: estimateTokens(compressed),
      mode: body.mode ?? null,
      session: body.session ?? null,
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    // Small artificial latency to make the pipeline visible in logs.
    setTimeout(() => res.end(JSON.stringify(payload)), 10);
  });
});

server.listen(PORT, () => {
  console.log(`[clair-mock] listening on http://127.0.0.1:${PORT} (POST /compress)`);
});
