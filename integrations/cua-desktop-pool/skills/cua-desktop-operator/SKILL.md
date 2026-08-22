---
name: cua-desktop-operator
description: Operate one or more isolated Cua GUI desktops through the cua_desktops MCP tools. Use for browser or desktop GUI automation, parallel independent GUI jobs, visual verification, desktop shell setup, screenshots, clipboard and files, or cleanup of persistent Cua desktops. Especially useful for weaker agents that need a strict observe-act-verify loop.
---

# Cua Desktop Operator

Use isolated named desktops predictably. Treat every click as an attempt, not proof.

## Before acting

1. Call `desktop_doctor`. If `image_status` is `missing`, stop and ask the user to run setup.
2. Call `desktop_list` before creating anything and record the initial names.
3. Reuse the task's existing desktop, or create a short unique name such as `invoice-1`.
4. If unrelated desktops fill the pool, stop and ask the user. Never free capacity by destroying them.
5. For independent jobs, assign one desktop name per job and run those desktops concurrently.
6. Never run concurrent action calls against the same desktop.

## Core GUI loop

Repeat this loop until the visible goal is proven:

1. `desktop_observe` and inspect the entire current screenshot.
2. Choose the smallest action that can advance the task.
3. Call `desktop_act` with one coherent batch, normally 1-4 actions.
4. `desktop_observe` again. Verify the expected visual change before continuing.
5. If the screen did not change as expected, reassess from the new screenshot. Do not repeat blind clicks.

Use screenshot pixel coordinates. Call `desktop_dimensions` when dimensions are unclear. Keep coordinates inside the image. Prefer keyboard navigation only when the current focus is visually known.

## Choose the right channel

- Use `desktop_shell` for deterministic installation, launching an app, checking a process, or preparing files.
- Use `desktop_file` for bounded text file reads/writes and directory listing.
- Use `desktop_clipboard` for transferring text into or out of the isolated desktop.
- Use `desktop_act` for interactions whose visible GUI behavior is the point of the task.
- Do not claim a GUI result based only on shell state. Verify the application screen.

## Recovery

If stuck:

1. Observe before doing anything else.
2. Check for modal dialogs, loading indicators, focus loss, disabled controls, and scroll position.
3. Use `desktop_shell` to check whether the target process is alive.
4. Try a single reversible action, then observe.
5. If the desktop is suspended, call `desktop_resume`.
6. If state is valuable but the job should stop, suspend instead of destroying.

## Completion and cleanup

Before reporting success, capture a final screenshot and confirm the requested visible state. Report the desktop name and `desktop_view` URL when the user may want to inspect it. Export every required result or artifact before cleanup.

Destroy only desktops created for this task, only when cleanup was requested or clearly agreed, and only after listing and matching the exact name. Pass `confirm=true`. Never destroy an unfamiliar desktop.

Read [references/tool-contract.md](references/tool-contract.md) when exact action shapes, limits, or failure rules are needed.
