# DEV — История разработки telegram-mcp

Этот файл для передачи контекста другой нейронке или разработчику.

---

## Хронология задач

### 1. Мультиаккаунт (начало)
**Задача:** Добавить поддержку нескольких Telegram аккаунтов через папку `session/`.
- Сканирование `session/*.session` при старте, создание `TelegramClient` для каждого
- `MULTI_ACCOUNT_CLIENTS: Dict[str, TelegramClient]` — пул клиентов
- Параметр `account_id` во все тулы (`send_message`, `get_messages`, `subscribe_public_channel` и 20+ других)
- `_get_client(account_id)` — единая точка получения клиента (default = основной из .env)
- Тулы: `list_accounts`, `check_account`, `check_all_accounts`, `clear_failed_accounts`, `delete_session`

### 2. Проблема зависаний (check_account "вечный раннинг")
**Проблема:** `check_account` вешал весь MCP — Telethon's `c.start()` блокировал event loop при мёртвых прокси/сессиях.
**Решение (итеративное, ~10 попыток):**
1. Таймауты (`asyncio.wait_for`) — не помогали, Telethon блокирует на уровне сокетов
2. `_force_kill_client` — отменяло task, но не разблокировало сокет
3. Многопоточность — несовместима с Telethon event loop
4. **Финальное решение:** disposable clients
   - `check_account` создаёт временный `TelegramClient` с агрессивными таймаутами (`timeout=4, connection_retries=0`)
   - Проходит стадии: `tmp.connect()` → `tmp.is_user_authorized()` → `tmp.get_me()` — каждая с отдельным таймаутом
   - При успехе — промоутит tmp в основной пул
   - При ошибке — `_safe_disconnect(tmp)`, основной пул не затронут
5. Предпроверки:
   - `_session_health_from_sqlite` — оффлайн проверка .session файла (auth_key, dc_id)
   - `_test_proxy_reachable` — TCP-проверка прокси перед полным подключением

### 3. Прокси и антидетект
**Задача:** Каждый аккаунт со своим прокси и device fingerprint.
- Типы прокси: MTProto, SOCKS5, HTTP
- Конфиг в `session/{name}.json` (поле `proxy`) или глобально в `session/proxies.json`
- `_build_proxy_kwargs` — конвертация конфига в Telethon kwargs
- `_normalize_mtproto_secret` — фикс бага Telethon с `dd`/`ee` префиксами MTProto secrets
- Monkey-patch `TcpMTProxy.normalize_secret` — чтобы принимал bytes напрямую
- Fingerprint из JSON: `device`, `sdk`, `app_version`, `lang_code`
- Тулы: `set_account_proxy`, `get_account_proxy`, `remove_account_proxy`, `rotate_proxies`, `show_proxy_pool`
- Hot-reload: `_reload_account_client` — пересоздаёт клиент без рестарта MCP

### 4. Нейрокомментинг (comment_on_post)
**Задача:** Оставлять комментарии в каналах через MCP.
- `comment_on_post(channel, comment, post_id, account_id)` — подписка на канал, вступление в discussion group, отправка комментария
- Баг: ссылка `t.me/c/CHANNEL_ID/POST_ID` — post_id в канале и в discussion group разные
- Фикс: `_resolve_channel_and_post` — маппинг discussion msg → channel post через `GetDiscussionMessageRequest`

### 5. Спамблок-проверка
**Задача:** Проверить все 47 аков на спамблок через @SpamBot.
- Отправка `/start` → чтение ответа
- Результат: 4 чистых, 32 заблокированы ("blocked for violations of ToS"), 11 мёртвых (session not authorized)
- Заблокированные аки: подключаются к API, пишут ботам, но НЕ могут резолвить юзернеймы, подписываться на каналы, писать юзерам

### 6. Крупный рефакторинг (февраль 2026)
**Задача:** Глобальная замена `client` на `_get_client(account_id)` во всех 70+ тулах.
**Проблемы и решения:**
1. **`_safe_start` использовал `c.start()` (интерактивный)** → заменён на `c.connect()` + `is_user_authorized()` — убраны все зависания от интерактивного ввода телефона
2. **`_get_client(None)` возвращал неавторизованный дефолтный клиент** → теперь проверяет авторизацию, если default неавторизован — автоматически берёт первый рабочий аккаунт из пула
3. **FloodWaitError** → хелпер `_safe_call(coro, max_retries=2)` — авторетрай с паузой до 60с
4. **Автоматизация** → `_refactor.py` скрипт для массовой замены `client` на `c` + добавление `account_id` параметра в 70+ функций
5. **SyntaxError после рефакторинга** → regex-патч для исправления некорректных сигнатур

**Обновлённые тулы:** view_posts, view_posts_quick, authorize_send_code, authorize_complete, add_session_string

### 7. Smooth Mode (февраль 2026)
**Проблема:** Агрессивная параллельная работа (5+ запросов одновременно, без пауз, без прокси) привела к массовой блокировке аккаунтов.
**Решение:**
- `_smooth_wait(account_id)` — задержка 8 сек между запросами к Telegram API
- `_smooth_config` — конфигурируемые параметры (delay, between_accounts, max_parallel, enabled)
- `session/smooth.json` — персистентный конфиг
- `set_smooth_mode` / `get_smooth_mode` — тулы для настройки на лету
- `check_all_accounts` — ждёт `delay_between_accounts` между каждым аком
- `.cursor/rules/telegram-smooth-mode.mdc` — правило для AI-агента (никогда не параллелить, 8 сек минимум, спрашивать про прокси)
- Предупреждения о работе без прокси в `list_accounts`, `check_account`, `remove_account_proxy`

---

## Архитектура

```
main.py (~5840 строк)
├── Импорты и патчи (1-50)
│   └── Monkey-patch TcpMTProxy.normalize_secret
├── Утилиты (60-375)
│   └── json_serializer, get_entity_type, format_*, validate_id, log_and_format_error
├── Мультиаккаунтный блок (376-1010)
│   ├── Константы: SESSION_DIR, MULTI_ACCOUNT_CLIENTS, _smooth_config, _failed_accounts
│   ├── Smooth mode: _smooth_wait, _load_smooth_config, _save_smooth_config
│   ├── tool_timeout декоратор
│   ├── Загрузка конфигов: _load_session_config, _save_session_config
│   ├── Прокси: _resolve_proxy, _build_proxy_kwargs, _normalize_mtproto_secret
│   ├── Клиенты: _create_session_client, _safe_disconnect, _safe_start, _get_client
│   ├── Диагностика: _session_health_from_sqlite, _test_proxy_reachable, _is_fatal_error
│   ├── Инициализация: сканирование session/, загрузка proxies.json
│   └── Тулы: list_accounts, check_account, check_all_accounts, delete_session,
│            set/get/remove_account_proxy, set/get_smooth_mode, clear_failed_accounts
├── Прокси-пул (1010-1120)
│   └── _collect_proxy_pool, rotate_proxies, show_proxy_pool
├── Основные тулы (1120-4700) — все с account_id
│   └── get_chats, get_messages, send_message, subscribe_public_channel,
│       list_inline_buttons, press_inline_button, search_*, resolve_username,
│       join_chat_by_link, forward_message, reply_to_message, leave_chat, ...
├── Нейрокомментинг (4700-5300)
│   └── _parse_tg_link, _resolve_channel_and_post, get_discussion_chat, comment_on_post
└── Точка входа (5330-5354)
    └── _main, main
```

## Ключевые файлы

| Файл | Описание |
|---|---|
| `main.py` | Основной файл MCP сервера (5354 строк) |
| `session/*.session` | SQLite сессии Telethon |
| `session/*.json` | Конфиг аккаунта (proxy, fingerprint, app_id) |
| `session/proxies.json` | Глобальные прокси (опционально) |
| `session/smooth.json` | Конфиг плавного режима |
| `MULTI-ACCOUNT.md` | Гайд по мультиаккаунту и smooth mode |
| `.cursor/rules/telegram-smooth-mode.mdc` | Правило для AI-агента |

## Известные проблемы

1. **Купленные сессии (api_id=2040):** 100% в спамблоке или мёртвые. Живут только "свои" (api_id=123456).
2. **Заблокированные аки:** подключаются к API но не могут резолвить юзернеймы — бесполезны для рассылки/подписок.
3. **Telethon `start()` может повесить event loop:** решено через disposable clients в `check_account`.
4. **MTProto secret dd/ee bug:** решено monkey-patch в начале файла.
5. **Session file locks:** решено через `gc.collect()` + retries в `delete_session`.

## Что делать при проблемах

- **"Connection closed" при старте MCP** → Синтаксическая ошибка в main.py. Запустить `python -c "import py_compile; py_compile.compile('main.py', doraise=True)"`.
- **Аккаунт в спамблоке** → `/start` к `@SpamBot`, если "blocked" — аккаунт мёртв для полезной работы.
- **check_account зависает** → Не должен (disposable client с timeout=4-6 сек). Если всё же — `_test_proxy_reachable` false = proxy мёртв.
- **Массовая блокировка** → `set_smooth_mode(delay=15, between_accounts=15)`, работать строго последовательно.
