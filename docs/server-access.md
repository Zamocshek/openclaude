# Persistent server access

OpenClaude keeps SSH profiles, keys, host fingerprints, and optional bootstrap
password files outside the container. Docker mounts the directory at
`/root/.ssh`, so recreating or updating NOVA does not remove server access.

Default host directory:

- installed profile: `~/.openclaude/ssh`
- portable profile: `./.openclaude-data/ssh`
- override: `OPENCLAUDE_HOST_SSH_DIR`

## Create a profile

```bash
openclaude-ssh init nova-vps 203.0.113.10 root 22
openclaude-ssh doctor nova-vps
```

`init` generates a dedicated Ed25519 key and an OpenSSH config fragment. It
does not accept a password on the command line.

For initial key installation, place the password in the protected file:

```text
/root/.ssh/secrets/nova-vps.password
```

Then run:

```bash
openclaude-ssh bootstrap-key nova-vps
openclaude-ssh run nova-vps -- uname -a
```

After `bootstrap-key` verifies key authentication, remove the password file.
Normal work uses the key and bounded keepalive settings.

The Gateway can run a bounded background recovery loop:

```env
OPENCLAUDE_SSH_AUTO_RECOVER=1
OPENCLAUDE_SSH_PROFILE=nova-vps
OPENCLAUDE_SSH_RETRY_SECONDS=300
```

When the provider firewall becomes reachable, the loop installs and verifies
the key and removes the bootstrap password automatically.

## Failure stages

`openclaude-ssh doctor` distinguishes DNS, local-client, TCP, host-key,
authentication, and remote-command failures. Container root access cannot
bypass a provider firewall or security group. If the result stops at TCP, open
the configured SSH port in the hosting panel or run
`scripts/release/vps-ssh-bootstrap.sh` from the provider console.
