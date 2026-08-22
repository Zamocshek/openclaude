# Decision log

## 2026-08-16

- Использовать `cua-sandbox==0.3.4`, а не тяжёлый meta-package `cua`.
- Использовать установленный Python 3.11: пакет поддерживает `>=3.11,<3.14`.
- Не использовать upstream DockerRuntime напрямую: он публикует ports на всех
  interfaces и не применяет resource limits.
- Не наследовать stale/перегруженный published image. Собирать совместимый lean
  Debian image с XFCE, Firefox и pinned `cua-computer-server`, не патча clone.
- Держать stdio MCP каноническим входом для агентов и CLI для человека.
