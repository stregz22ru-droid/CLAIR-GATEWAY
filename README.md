# CLAIR Gateway

Прозрачный OpenAI-совместимый прокси, который **автоматически сжимает промпты через CLAIR Base** перед отправкой в LLM. Для агента это обычный OpenAI API — меняется только `base_url`.

```text
┌─────────┐   OpenAI format   ┌─────────────────┐   сжатый промпт   ┌──────────┐
│  Агент  │ ────────────────► │  CLAIR Gateway  │ ────────────────► │  LLM API │
│(без изм.)│ ◄──────────────── │   (прокси +     │ ◄──────────────── │(OpenAI-  │
└─────────┘   ответ как есть  │    сжатие)      │   ответ как есть  │ совмест.)│
                              └────────┬────────┘                   └──────────┘
                                       │ POST /compress (только HTTP, код не трогаем)
                                       ▼
                              ┌─────────────────┐
                              │   CLAIR Base    │
                              │  (immutable)    │
                              └─────────────────┘
```

## Возможности

- **Drop-in совместимость**: `POST /v1/chat/completions` в формате OpenAI, ответы и ошибки — в формате OpenAI
- **Автоматическое сжатие** промптов через `POST {CLAIR_BASE_URL}/compress`
- **A/B на лету**: заголовок `X-Clair-Compress: false` отключает сжатие для одного запроса (и `true` — включает даже при выключенном env)
- **SSE-стриминг** (`stream: true`) проксируется chunk-by-chunk, без буферизации
- **Стратегия отказа**: `CLAIR_FAIL_STRATEGY=fail_open` (по умолчанию) / `fail_closed`
- **JSONL-лог** каждой операции: `original_tokens`, `compressed_tokens`, `saved_tokens`, `compression_ratio`, `llm_response_tokens`, `latency_ms`
- Работает с любым OpenAI-совместимым бэкендом: OpenAI, vLLM, Ollama, LM Studio
- Адаптер к схеме CLAIR: автоопределение полей + `CLAIR_TEXT_FIELD`/`CLAIR_RESPONSE_FIELD` для тонкой настройки без изменения кода

## Быстрый старт

### npm

```bash
npm ci
cp .env.example .env        # при необходимости поправьте значения
npm start                   # сборка + запуск на http://localhost:8080
```

### Docker Compose — демо одной командой (моки CLAIR и LLM внутри, ключи не нужны)

```bash
docker compose up --build
# Gateway:  http://localhost:8080
# clair-mock: :3000, llm-mock: :4000 (внутри сети compose)
```

### Моки без Docker

```bash
npm run mock:clair &        # фейковый CLAIR Base на :3000
npm run mock:llm &          # фейковый OpenAI-совместимый LLM на :4000
```

## Демо: A/B-тест сжатия

```bash
# Со сжатием (поведение по умолчанию)
curl -s http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Расскажи про обратные прокси в одном абзаце"}]}'

# Без сжатия — та же команда + один заголовок
curl -s http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'X-Clair-Compress: false' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Расскажи про обратные прокси в одном абзаце"}]}'

# Сравнение в JSONL-логе Gateway
tail -n 2 logs/gateway.jsonl
```

Готовый smoke-скрипт: `./examples/curl_test.sh`, пример агента на Python: `examples/python_agent.py`.

## Подключение агента — одна строчка

```python
client = OpenAI(base_url="http://localhost:8080/v1", api_key="...")
```

## Тесты

```bash
npm test
```

Покрыты **все 7 обязательных сценариев ТЗ**:

| # | Сценарий | Где |
|---|---|---|
| 1 | Базовый прокси-запрос | `tests/proxy.test.ts` |
| 2 | Сжатие включено — токены экономятся (в т.ч. 1000→650, ratio 1.54 из примера ТЗ) | `tests/proxy.test.ts` |
| 3 | Сжатие выключено через `COMPRESSION_ENABLED=false` | `tests/proxy.test.ts` |
| 4 | Сжатие выключено через header `X-Clair-Compress: false` | `tests/proxy.test.ts` |
| 5 | CLAIR недоступен: `fail_open` / `fail_closed` / таймаут | `tests/proxy.test.ts` |
| 6 | Некорректный запрос → 400 в формате OpenAI error | `tests/proxy.test.ts` |
| 7 | A/B: два одинаковых запроса, один со сжатием | `tests/ab.test.ts` |

Плюс unit-тесты клиента CLAIR (`tests/compressor.test.ts`), JSONL-лог формата ТЗ, SSE, мультимодальный контент, passthrough `/v1/models`.

## Документация

| Файл | Содержание |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Установка, все переменные окружения, подключение реального CLAIR/LLM, troubleshooting |
| [docs/API.md](docs/API.md) | API Gateway, формат ошибок, формат JSONL-лога, контракт CLAIR Base |
| [docs/README.md](docs/README.md) | Архитектура, обоснование решений, точки расширения |
| [REPORT.md](REPORT.md) | Отчёт: стек, архитектурные решения, ограничения, запуск |
| [examples/](examples) | `curl_test.sh` + `python_agent.py` |

## Безопасность

- Ключи передаются только через переменные окружения (`LLM_API_KEY`); в коде и репозитории ключей нет.
- CLAIR Base не модифицируется — взаимодействие исключительно через его HTTP API.
- Runtime-зависимость одна (Express); образ на alpine, процесс — не root, есть HEALTHCHECK.

## Лицензия

MIT — см. [LICENSE](LICENSE).
