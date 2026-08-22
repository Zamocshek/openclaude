# Cua desktop tool contract

## Lifecycle

- `desktop_doctor()` checks Docker, the image, limits, and active count.
- `desktop_create(name)` creates a persistent desktop. Default pool limit is 2.
- `desktop_list()` lists only this project's labeled containers.
- `desktop_view(name)` returns state and local noVNC URL.
- `desktop_suspend(name)` pauses while preserving state.
- `desktop_resume(name)` resumes a paused desktop.
- `desktop_destroy(name, confirm=true)` permanently deletes exactly one named pool desktop.

## Observation and input

- `desktop_observe(name, image_format="png", quality=90)` returns a screenshot.
- `desktop_dimensions(name)` returns `{width, height}`.
- `desktop_act(name, actions)` accepts 1-25 ordered actions and serializes them for that desktop.

Action schemas:

```json
{"type":"click", "x":100, "y":200, "button":"left"}
{"type":"right_click", "x":100, "y":200}
{"type":"double_click", "x":100, "y":200}
{"type":"move", "x":100, "y":200}
{"type":"scroll", "x":100, "y":200, "scroll_x":0, "scroll_y":3}
{"type":"drag", "start_x":10, "start_y":20, "end_x":200, "end_y":220}
{"type":"type", "text":"literal text"}
{"type":"keypress", "keys":["ctrl","l"]}
{"type":"wait", "seconds":1}
```

Coordinates are zero-based screenshot pixels. A completed action call means input was sent; it does not prove the UI accepted it.
Use lowercase key names such as `ctrl`, `alt`, `shift`, `enter`, `tab`, `esc`, and letters. The pool normalizes case before calling the Linux backend. Positive `scroll_y` follows Cua's current backend direction; verify the resulting page movement visually rather than assuming it.

## Shell, clipboard, files

- `desktop_shell(name, command, timeout=30, background=false)` allows 1-600 seconds and returns `stdout`, `stderr`, `returncode`, `truncated`.
- `desktop_clipboard(name, operation="get|set", text=null)` operates on isolated clipboard text.
- `desktop_file(name, operation="read_text|write_text|list", path, content=null)` handles bounded text and directory entries.

## Parallelism

Different desktop names can safely work in parallel. A single MCP server process has one writer lock per desktop. Do not launch multiple MCP server processes that write to the same desktop concurrently.

## Failure rules

- Missing image: run project setup or `cua-desktop-pool build-image` outside MCP.
- Desktop not running: inspect with list/view; resume if suspended.
- Unexpected GUI: observe and reason from the new screenshot; do not replay blind actions.
- Destruction refusal: pass confirmation only after exact-name verification.
