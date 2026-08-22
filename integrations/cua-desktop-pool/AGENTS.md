# Agent instructions

- Use the `cua-desktop-operator` skill in `skills/cua-desktop-operator` for GUI work.
- Treat `vendor/cua` as pinned upstream source. Do not edit it for local fixes.
- Use one writer per desktop and a unique desktop name per parallel task.
- Prefer shell/file tools for deterministic work; use GUI actions only for visible state.
- Follow `observe -> small action batch -> observe -> verify`.
- Destroy only desktops created for the current task and pass explicit confirmation.
- Do not publish container ports beyond loopback or mount host secrets into desktops.
