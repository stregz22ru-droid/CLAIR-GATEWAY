#!/usr/bin/env bash
# Smoke-test for CLAIR Gateway: health, compressed request, bypass request, invalid request.
#
# Usage: ./curl_test.sh [gateway_url]     (default: http://localhost:8080)
# Requires: curl. A demo stack (gateway + mocks) can be started with `docker compose up --build`.
set -uo pipefail

GATEWAY_URL="${1:-http://localhost:8080}"
BODY='{"model":"gpt-4o-mini","messages":[{"role":"system","content":"You are a concise assistant. Always answer in one short sentence."},{"role":"user","content":"Explain in one sentence what a reverse proxy is and why it is useful."}]}'

echo "==> 1/4 Health check: GET $GATEWAY_URL/health"
curl -sf "$GATEWAY_URL/health" || { echo "Gateway is not reachable at $GATEWAY_URL"; exit 1; }
echo; echo

echo "==> 2/4 Chat completion WITH compression (default behaviour)"
curl -s "$GATEWAY_URL/v1/chat/completions" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer ${LLM_API_KEY:-sk-demo}" \
  -d "$BODY"
echo; echo

echo "==> 3/4 Chat completion WITHOUT compression (X-Clair-Compress: false)"
curl -s "$GATEWAY_URL/v1/chat/completions" \
  -H 'content-type: application/json' \
  -H 'X-Clair-Compress: false' \
  -H "authorization: Bearer ${LLM_API_KEY:-sk-demo}" \
  -d "$BODY"
echo; echo

echo "==> 4/4 Invalid request (expect HTTP 400 in the OpenAI error format)"
curl -s -w '\nHTTP status: %{http_code}\n' "$GATEWAY_URL/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"messages":[]}' || true

echo
echo "Done. Compare the two branches in the JSONL operation log:"
echo "  tail -n 2 logs/gateway.jsonl   # original_tokens / compressed_tokens / saved_tokens"
