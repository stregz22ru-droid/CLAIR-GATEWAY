# Установка и запуск

## Требования

- **Node.js 20+** и npm 10+ (для запуска из исходников)
- либо **Docker** 24+ с compose v2 (для контейнерного запуска)

## Вариант 1: из исходников (npm)

```bash
# 1. Зависимости (включая dev-зависимости для сборки и тестов)
npm ci

# 2. Конфигурация
cp .env.example .env
# отредактируйте .env: как минимум LLM_PROVIDER_URL / LLM_API_KEY для реального LLM

# 3. Запуск (prestart-хук сам выполнит сборку)
npm start                # Gateway на http://localhost:8080

# Режим разработки с автоперезагрузкой:
npm run dev
```

## Вариант 2: Docker Compose (демо одной командой)

```bash
docker compose up --build
```

Поднимаются три сервиса:

| Сервис | Адрес | Назначение |
|---|---|---|
| `clair-gateway` | http://localhost:8080 | сам Gateway (deliverable) |
| `clair-mock` | `clair-mock:3000` внутри сети | фейковый CLAIR Base (`POST /compress`) |
| `llm-mock` | `llm-mock:4000` внутри сети | фейковый OpenAI-совместимый LLM |

Моки дают полностью работоспособное демо **без реального CLAIR, без ключей и без интернета** — удобно для скринкаста. Проверка:

```bash
curl -s http://localhost:8080/health
docker compose exec clair-gateway cat /app/logs/gateway.jsonl
```

Только образ Gateway без compose:

```bash
docker build -f docker/Dockerfile -t clair-gateway .
docker run -p 8080:8080 \
  -e CLAIR_BASE_URL=http://host.docker.internal:3000 \
  -e LLM_PROVIDER_URL=https://api.openai.com \
  -e LLM_API_KEY=sk-... \
  clair-gateway
```

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PORT` | `8080` | Порт Gateway |
| `CLAIR_BASE_URL` | `http://127.0.0.1:3000` | Адрес CLAIR Base (без `/compress`) |
| `CLAIR_TIMEOUT_MS` | `10000` | Таймаут одного вызова `/compress` |
| `CLAIR_TEXT_FIELD` | `text` | Имя поля запроса, в которое кладётся промпт |
| `CLAIR_RESPONSE_FIELD` | авто | Dot-path до сжатого текста в ответе (напр. `data.compressed_text`); без неё — автоопределение |
| `LLM_PROVIDER_URL` | `https://api.openai.com` | Корень LLM API; можно с `/v1` и без — дубликаты не появятся |
| `LLM_API_KEY` | пусто | Ключ для `Authorization: Bearer …`; если пусто — проброс входящего `Authorization` |
| `LLM_TIMEOUT_MS` | `300000` | Таймаут до получения заголовков LLM (0 — выключить) |
| `COMPRESSION_MODE` | `medium` | `low` / `medium` / `high` — передаётся в CLAIR |
| `COMPRESSION_ENABLED` | `true` | Глобальный A/B-выключатель |
| `CLAIR_FAIL_STRATEGY` | `fail_open` | `fail_open` — идти в LLM без сжатия; `fail_closed` — 503 |
| `SESSION_NAME` | `clair-gateway` | Метка сессии: уходит в CLAIR и в JSONL-лог |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` (stdout) |
| `LOG_FILE` | `logs/gateway.jsonl` | JSONL-лог операций; `none` — отключить файл |
| `BODY_LIMIT_MB` | `20` | Лимит размера тела запроса |

## Подключение к реальному CLAIR Base

1. Запустите CLAIR Base (например, сервис из `c:\Clair_pilot`) и убедитесь, что отвечает `POST /compress`.
2. В `.env` укажите `CLAIR_BASE_URL=http://127.0.0.1:3000` (или фактический адрес) и реальный `LLM_PROVIDER_URL` + `LLM_API_KEY`.
3. Если CLAIR принимает промпт не в поле `text` — выставьте `CLAIR_TEXT_FIELD` (например, `prompt`).
4. Если ответ CLAIR не распознался автоматически (в логе появится `ClairBadResponseError`) — посмотрите фактический JSON ответа и пропишите dot-path в `CLAIR_RESPONSE_FIELD`, например `data.compressed_text`.

Код Gateway при этом **не меняется** — весь демо-набор форм ответа уже покрыт тестами.

## Моки для локального демо

```bash
npm run mock:clair &     # :3000
npm run mock:llm &       # :4000
CLAIR_BASE_URL=http://127.0.0.1:3000 LLM_PROVIDER_URL=http://127.0.0.1:4000 npm start
./examples/curl_test.sh
```

## Troubleshooting

| Симптом | Причина / решение |
|---|---|
| В логе `clair_unavailable_fail_open`, запросы проходят без сжатия | CLAIR Base не запущен или `CLAIR_BASE_URL` неверный; это ожидаемое поведение `fail_open` |
| `503 … fail_closed` | То же самое, но включена жёсткая стратегия; проверьте доступность CLAIR или верните `fail_open` |
| `ClairBadResponseError: Could not find compressed text…` | Ответ CLAIR нестандартный; задайте `CLAIR_RESPONSE_FIELD` |
| `413 body_too_large` | Промпт больше `BODY_LIMIT_MB` — увеличьте лимит |
| Порт занят | `PORT=8081 npm start` |
| JSONL-лог пустой | Проверьте `LOG_FILE`; запросы без `/v1/chat/completions` в лог операций не попадают (только passthrough-событие в stdout) |
