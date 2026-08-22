# Invariants

- Один writer на desktop внутри процесса; разные desktop независимы.
- Любой Docker lifecycle action проверяет label `cua.pool=true`.
- API/noVNC публикуются только на `127.0.0.1`.
- Имена нормализуются под prefix `cua-pool-`.
- Количество desktop ограничено до запуска нового контейнера.
- Shell output и batch action count ограничены.
- Успешный tool call не считается успешной GUI-задачей без повторного observe.
- Destroy требует `confirm=true` в MCP и `--yes` в CLI.
- Upstream `vendor/cua` не модифицируется локальными патчами.
