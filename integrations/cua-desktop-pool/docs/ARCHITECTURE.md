# Architecture

```text
OpenCode / OpenClaw / Codex / Claude / Cursor
                    |
                 stdio MCP
                    |
             Cua Desktop Pool
       locks / limits / Docker lifecycle
                    |
         Cua Sandbox HTTP transport
                    |
       N x Docker + XFCE + computer-server
```

Один Python-процесс предоставляет CLI и MCP. `DockerRuntime` создаёт только
контейнеры с label `cua.pool=true`, публикует 8000/6901 на случайные loopback
ports и применяет CPU/RAM limits. Cua Sandbox подключается к найденному HTTP
port и выполняет desktop actions.

`Cua Driver` для реального Windows desktop остаётся отдельным upstream MCP и не
проксируется этим проектом.
