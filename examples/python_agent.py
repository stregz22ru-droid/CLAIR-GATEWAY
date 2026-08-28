"""CLAIR Gateway — drop-in demo for an OpenAI-based agent.

The agent code does not change at all: the ONLY line that differs from a
plain OpenAI integration is `base_url`, which now points at the gateway.

    pip install openai
    python examples/python_agent.py        # gateway on http://localhost:8080
"""

from openai import OpenAI

# ── The only line an agent changes to start using CLAIR Gateway ─────────────
client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="sk-demo",  # the gateway can inject the real key via LLM_API_KEY
)

MODEL = "gpt-4o-mini"

MESSAGES = [
    {"role": "system", "content": "You are a concise assistant. Answer in one sentence."},
    {"role": "user", "content": "Why compress prompts before sending them to an LLM?"},
]


def main() -> None:
    # 1) Regular request: the gateway compresses the prompt via CLAIR Base
    #    automatically. From the agent's point of view it is a normal OpenAI call.
    answer = client.chat.completions.create(model=MODEL, messages=MESSAGES)
    print("[compression on ]", answer.choices[0].message.content)

    # 2) A/B test: bypass compression for this single request via a header.
    raw = client.chat.completions.create(
        model=MODEL,
        messages=MESSAGES,
        extra_headers={"X-Clair-Compress": "false"},
    )
    print("[compression off]", raw.choices[0].message.content)

    # 3) Streaming works transparently as well (SSE is proxied chunk-by-chunk).
    print("[streaming       ]", end=" ")
    stream = client.chat.completions.create(model=MODEL, messages=MESSAGES, stream=True)
    for chunk in stream:
        if chunk.choices and chunk.choices[0].delta.content:
            print(chunk.choices[0].delta.content, end="", flush=True)
    print()

    # Now compare both branches in the gateway operation log:
    #   tail -n 2 logs/gateway.jsonl
    #   → branch 1: saved_tokens > 0, branch 2: compression_disabled_by_header


if __name__ == "__main__":
    main()
