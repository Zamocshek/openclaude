#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root from the VPS provider console." >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This bootstrap currently supports Debian/Ubuntu hosts with apt-get." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends openssh-server ufw ca-certificates curl

install -d -m 0755 /run/sshd
/usr/sbin/sshd -t
systemctl enable --now ssh 2>/dev/null || service ssh restart

ssh_port="$(/usr/sbin/sshd -T | awk '$1 == "port" { print $2; exit }')"
if [[ ! "${ssh_port}" =~ ^[0-9]+$ ]] || (( ssh_port < 1 || ssh_port > 65535 )); then
  echo "Could not determine a valid sshd port." >&2
  exit 1
fi

ufw default deny incoming
ufw default allow outgoing
ufw allow "${ssh_port}/tcp" comment 'OpenSSH management'
ufw allow 80/tcp comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'

IFS=',' read -ra extra_ports <<< "${OPENCLAUDE_VPS_EXTRA_TCP_PORTS:-}"
for port in "${extra_ports[@]}"; do
  port="${port//[[:space:]]/}"
  [[ -z "${port}" ]] && continue
  if [[ ! "${port}" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
    echo "Invalid extra TCP port: ${port}" >&2
    exit 1
  fi
  ufw allow "${port}/tcp" comment 'OpenClaude explicit service port'
done

ufw --force enable

echo "SSH service and host firewall configured."
echo "sshd port: ${ssh_port}"
ufw status verbose
ss -lntp | grep -E ":(${ssh_port}|80|443)([[:space:]]|$)" || true
echo "Also allow the same ports in the hosting provider security group/firewall."
