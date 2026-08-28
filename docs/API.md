# CLAIR Gateway — API

Gateway прозрачен: всё, что агент отправляет в OpenAI API, он отправляет сюда, только на `base_url` Gateway.

## Эндпоинты

| Метод и путь | Поведение |
|---|---|
| `POST /v1/chat/completions` | Основной маршрут: валидация → (сжатие через CLAIR) → пересылка в LLM → лог. Ответ LLM возвращается байт в байт |
| `GET /v1/models` и прочие `/v1/*` | Pass-through в LLM **без сжатия** — полная прозрачность для остальных вызовов SDK |
| `GET /health` | `{ "status": "ok", "service": "clair-gateway", "version": "1.0.0" }` |
| остальные пути | `404` в формате OpenAI error |

## Заголовки запроса

| Заголовок | Значения | Действие |
|---|---|---|
| `X-Clair-Compress` | `false` / `0` / `off` | Пропустить сжатие для этого запроса (A/B-ветка B) |
| | `true` / `1` / `on` | Включить сжатие даже при `COMPRESSION_ENABLED=false` |
| | отсутствует | Действует `COMPRESSION_ENABLED` из конфига |
| `Authorization` | любой | Используется, только если `LLM_API_KEY` пуст; иначе ключ подставляется из конфига |

Заголовок `X-Clair-Compress` никогда не передаётся в LLM.

## Заголовки ответа

| Заголовок | Значения | Смысл |
|---|---|---|
| `X-Clair-Cache` | `MISS` | Все тексты сжаты свежим вызовом CLAIR |
| | `HIT` | Все тексты взяты из кэша промптов — CLAIR не вызывался |
| | `PARTIAL` | Часть текстов из кэша, часть — свежие (напр. system-промпт закэширован, вопрос — новый) |
| | `BYPASS` | Сжатие отключено (заголовком или конфигом) — мимо кэша |

Заголовок `X-Clair-Cache` также не передаётся в LLM; он ставится на все ответы, дошедшие до стадии пересылки (на 503 `fail_closed` его нет).

## Кэш промптов

In-memory LRU-кэш перед CLAIR Base: ключ — SHA-256 точного текста, отправляемого в CLAIR; значение — сжатый текст и счётчики токенов (хит переигрывает ровно те же числа, что выдал бы CLAIR).

- Кэшируется только успешное сжатие с реальной выгодой; no-gain результаты и отказы CLAIR (`fail_open`) не сохраняются — transient-сбой не может отравить кэш.
- Один процесс = один кэш: рестарт или смена `COMPRESSION_MODE` начинает с чистого листа.
- Настраивается `CLAIR_CACHE_TTL_MS` (по умолчанию 300 000 мс) и `CLAIR_CACHE_MAX_ENTRIES` (по умолчанию 500); `0` в любой из них выключает кэш целиком.
- Наблюдаемость: `X-Clair-Cache` в каждом ответе и `cache_hits`/`cache_misses` в JSONL-логе (при выключенном кэше — всегда `0/0`).

## Пример запроса и ответа

```bash
curl -s http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello!"}]}'
```

Ответ — ровно то, что вернул LLM (тот же статус, тот же JSON). Для стриминга (`"stream": true`) SSE-поток проксируется chunk-by-chunk с `content-type: text/event-stream`.

## Формат ошибок (везде — OpenAI error)

```json
{ "error": { "message": "…", "type": "…", "param": null, "code": "…" } }
```

| Статус | `type` | `code` | Когда |
|---|---|---|---|
| 400 | `invalid_request_error` | `invalid_request` | Не прошёл валидацию (нет `model`, пустой `messages`, кривой `content`) |
| 400 | `invalid_request_error` | `invalid_json` | Тело не является валидным JSON |
| 413 | `invalid_request_error` | `body_too_large` | Тело больше `BODY_LIMIT_MB` |
| 404 | `invalid_request_error` | `not_found` | Путь вне `/v1/*` |
| 502 | `clair_gateway_error` | `upstream_unreachable` | LLM недоступен/таймаут |
| 503 | `clair_gateway_error` | `clair_unavailable` | CLAIR недоступен при `CLAIR_FAIL_STRATEGY=fail_closed` |
| 500 | `clair_gateway_error` | `internal_error` | Непредвиденная ошибка Gateway |

Ошибки самого LLM (401, 429, 500…) **пробрасываются как есть** — агент обрабатывает их, как будто говорит с OpenAI напрямую.

## JSONL-лог операций

Каждый запрос `POST /v1/chat/completions` дописывает строку в `LOG_FILE` (по умолчанию `logs/gateway.jsonl`):

```json
{
  "timestamp": "2026-08-28T10:15:32.100Z",
  "session": "clair-gateway",
  "request_id": "0d5c…",
  "route": "chat_completions",
  "model": "gpt-4o-mini",
  "compression_enabled": true,
  "stream": false,
  "original_tokens": 1000,
  "compressed_tokens": 650,
  "saved_tokens": 350,
  "compression_ratio": 1.54,
  "cache_hits": 0,
  "cache_misses": 1,
  "llm_response_tokens": 200,
  "latency_ms": 145,
  "status": 200,
  "note": null
}
```

Значения `note`:

| note | Смысл |
|---|---|
| `null` | Обычный успешный прогон со сжатием |
| `compression_disabled_by_config` | Сжатие выключено через `COMPRESSION_ENABLED=false` |
| `compression_disabled_by_header` | Сжатие выключено заголовком `X-Clair-Compress: false` |
| `compression_no_gain` | CLAIR вернул текст не короче оригинала — отправлен оригинал |
| `clair_unavailable_fail_open` | CLAIR недоступен, запрос прошёл без сжатия |
| `clair_unavailable_fail_closed` | CLAIR недоступен, клиенту возвращён 503 |
| `validation_failed` | Запрос не прошёл валидацию (400) |
| `upstream_unreachable` | LLM недоступен (502) |

Источники чисел: `original_tokens`/`compressed_tokens` — счётчики CLAIR, если он их вернул, иначе эвристика (хит кэша возвращает сохранённые значения того же происхождения); `llm_response_tokens` — `usage.completion_tokens` из ответа LLM (для стриминга — `null`).

## Контракт CLAIR Base (что Gateway отправляет и ожидает)

Запрос — `POST {CLAIR_BASE_URL}/compress`:

```json
{ "text": "исходный промпт", "session": "clair-gateway", "mode": "medium" }
```

`text` переименовывается переменной `CLAIR_TEXT_FIELD`, `mode` берётся из `COMPRESSION_MODE`, `session` — из `SESSION_NAME`.

Ответ распознаётся автоматически (порядок приоритета):

- сжатый текст: `compressed` → `compressed_text` → `compressedText` → `compressed_prompt` → `result` (в т.ч. во вложенных объектах до 3 уровней);
- токены: `original_tokens`/`tokens_before`/`input_tokens`… и `compressed_tokens`/`tokens_after`/`output_tokens`…;
- если ничего не нашлось — `ClairBadResponseError`, и точное поле задаётся `CLAIR_RESPONSE_FIELD` (dot-path, напр. `data.compressed_text`).

Неизвестные поля ответа игнорируются, так что расширенные ответы CLAIR безопасны.

## Стриминг

- Запрос со `"stream": true` сжимается так же, как обычный.
- Ответ отдаётся клиенту без буферизации: каждый chunk апстрима уходит немедленно.
- Если клиент обрывает соединение — upstream-запрос абортится (не тратим токены и соединения).
- `LLM_TIMEOUT_MS` ограничивает только время до получения заголовков ответа; долгий стрим не прервётся по таймауту.
