---
name: server-access
description: Maintain reliable persistent SSH access to user-owned servers from NOVA. Use for VPS deployment, diagnostics, remote coding, service management, or when a previous SSH connection was lost.
compatibility: openclaude hermes opencode openclaw codex
---

# Persistent server access

Use `openclaude-ssh`; do not rediscover credentials or improvise raw `sshpass -p`
commands on every task.

## Required workflow

1. Run `openclaude-ssh doctor <profile>` before authentication.
2. If the result stops at `tcp`, report that the remote/provider firewall is
   blocking the port. Root permissions inside the agent cannot bypass it.
3. Use `openclaude-ssh run <profile> -- <command...>` for remote work.
4. Prefer the persistent Ed25519 key. A password file is only a bootstrap
   fallback and must never be printed, passed in argv, logs, or chat.
5. After network access returns, run `openclaude-ssh bootstrap-key <profile>`,
   verify key authentication, then remove the password file.
6. Do not claim that a server is down after checking only DNS or one runtime.
   Distinguish DNS, local client, TCP, host key, authentication, and remote
   command failure.

Default profile: `nova-vps`. Persistent state lives in `/root/.ssh`, mounted
from the host OpenClaude config directory so container recreation does not lose
keys, known hosts, or profile configuration.

The Gateway starts `openclaude-ssh watch nova-vps` when auto-recovery is
enabled. It retries at a bounded interval and removes the bootstrap password
after key authentication is installed and verified.
