# Cua Desktop Pool

Локальный пул параллельных GUI-рабочих столов для OpenCode, OpenClaw, Codex,
Claude Code, Cursor и любого stdio MCP-клиента.

Проект использует `cua-sandbox` для screenshots/mouse/keyboard/shell/files, но
сам запускает Docker-контейнеры, чтобы:

- публиковать API и noVNC только на `127.0.0.1`;
- ограничивать CPU и RAM;
- обходить сломанный и перегруженный опубликованный `trycua/cua-xfce:latest`
  собственным совместимым lean-образом;
- надёжно перечислять, приостанавливать и удалять только свои контейнеры.

## Быстрый старт

Требования: Windows 10/11, Docker Desktop с Linux containers, `uv`, Git.

```powershell
Set-Location .\cua-desktop-pool
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

Первый build ставит XFCE, Firefox и Cua computer-server в lean Debian image.
Повторные запуски используют Docker cache.

Проверка без агента:

```powershell
.\.venv\Scripts\cua-desktop-pool.exe doctor
.\.venv\Scripts\cua-desktop-pool.exe create demo
.\.venv\Scripts\cua-desktop-pool.exe shell demo "uname -a"
.\.venv\Scripts\cua-desktop-pool.exe screenshot demo --out screenshots\demo.png
.\.venv\Scripts\cua-desktop-pool.exe view demo --open
.\.venv\Scripts\cua-desktop-pool.exe destroy demo --yes
```

## Подключение агента

Сгенерировать все конфиги:

```powershell
.\.venv\Scripts\cua-desktop-pool.exe connect --client all
```

Подключить через официальный CLI, если он установлен:

```powershell
.\.venv\Scripts\cua-desktop-pool.exe connect --client codex --apply
.\.venv\Scripts\cua-desktop-pool.exe connect --client claude --apply
```

Для любого другого MCP-клиента взять
`integrations/generated/generic.mcp.json`. Сервер запускается отдельным
entrypoint без shell-обёрток:

```text
.venv\Scripts\cua-desktop-pool-mcp.exe
```

Команда `connect` генерирует актуальные конфиги для OpenCode v1/v2, OpenClaw,
Codex, Claude Code, Cursor и generic MCP. После переноса папки запустите её
снова, чтобы все локальные пути соответствовали новой машине.

Для агентной экосистемы сервер также запускается как переносимый Streamable
HTTP MCP. `Dockerfile.mcp` поднимает endpoint `/mcp`, проверяет desktop image и
работает через Docker socket. В Compose задайте общую сеть через
`CUA_POOL_DOCKER_NETWORK`; локальный stdio-режим остаётся режимом по умолчанию.

## Skill для агента

Операторский skill находится в `skills/cua-desktop-operator`. Он задаёт
обязательный цикл `observe -> небольшой act -> observe`, правила параллельных
desktop и безопасного cleanup. В этой установке он также подключён в личные
Codex skills как `$cua-desktop-operator`; новый Codex task увидит его после
перезапуска/перезагрузки списка skills. Другие агенты могут читать тот же
`SKILL.md` прямо из проекта.

## Параллелизм

По умолчанию разрешено два desktop. Каждый desktop имеет собственные X server,
clipboard, browser и input devices. Действия внутри одного desktop
сериализуются; разные desktop работают параллельно.

Параметры задаются переменными из `.env.example`. Автоматического чтения `.env`
нет: перед запуском экспортировать нужные переменные либо оставить defaults.

## Upstream

Актуальный sparse clone Cua находится в `vendor/cua`. Вернуть полный checkout:

```powershell
git -C vendor\cua sparse-checkout disable
```

Лицензия Cua — MIT. Локальный runtime использует опубликованный
`cua-computer-server==0.3.42` и не изменяет upstream clone.
