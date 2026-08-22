# Known issues

- Upstream `trycua/cua-xfce:latest` содержит два слоя по 3+ ГБ и опубликован с
  loopback-only computer-server; проект намеренно его не использует.
- Первый build lean-образа всё равно устанавливает XFCE и Firefox и занимает время.
- Background automation реального Windows desktop выполняется отдельным
  `cua-driver`, не этим Docker pool.
- Locks защищают один MCP process. Разным MCP server processes следует выдавать
  разные desktop names.
- Docker desktop state исчезает после `destroy`; snapshots пока не реализованы.
