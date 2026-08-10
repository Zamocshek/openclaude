#!/bin/sh
set -eu

STATE_DIR="${OPENCLAUDE_SSH_STATE_DIR:-/root/.ssh}"
PROFILE="${OPENCLAUDE_SSH_PROFILE:-nova-vps}"
CONNECT_TIMEOUT="${OPENCLAUDE_SSH_CONNECT_TIMEOUT_SECONDS:-8}"

die() {
  printf 'openclaude-ssh: %s\n' "$*" >&2
  exit 1
}

validate_name() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9._-]+$' || die "invalid profile name: $1"
}

validate_port() {
  case "$1" in
    ''|*[!0-9]*) die "invalid SSH port: $1" ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ] || die "invalid SSH port: $1"
}

prepare_state() {
  umask 077
  mkdir -p "$STATE_DIR/config.d" "$STATE_DIR/secrets"
  chmod 700 "$STATE_DIR" "$STATE_DIR/config.d" "$STATE_DIR/secrets" 2>/dev/null || true
  touch "$STATE_DIR/known_hosts"
  chmod 600 "$STATE_DIR/known_hosts" 2>/dev/null || true
  if [ ! -f "$STATE_DIR/config" ]; then
    printf 'Include %s/config.d/*.conf\n' "$STATE_DIR" > "$STATE_DIR/config"
  elif ! grep -Fqx "Include $STATE_DIR/config.d/*.conf" "$STATE_DIR/config"; then
    printf '\nInclude %s/config.d/*.conf\n' "$STATE_DIR" >> "$STATE_DIR/config"
  fi
  chmod 600 "$STATE_DIR/config" 2>/dev/null || true
}

profile_value() {
  ssh -F "$STATE_DIR/config" -G "$1" 2>/dev/null | awk -v key="$2" '$1 == key { print $2; exit }'
}

doctor() {
  alias_name="$1"
  host="$(profile_value "$alias_name" hostname)"
  port="$(profile_value "$alias_name" port)"
  [ -n "$host" ] || die "profile not found: $alias_name"
  exec openclaude-ssh-doctor "$host" "${port:-22}" --timeout-ms "$((CONNECT_TIMEOUT * 1000))" --strict
}

ssh_base() {
  alias_name="$1"
  shift
  ssh -F "$STATE_DIR/config" \
    -o "ConnectTimeout=$CONNECT_TIMEOUT" \
    -o ConnectionAttempts=2 \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    "$alias_name" "$@"
}

key_ready() {
  ssh -F "$STATE_DIR/config" \
    -o "ConnectTimeout=$CONNECT_TIMEOUT" \
    -o ConnectionAttempts=1 \
    -o BatchMode=yes \
    "$1" true >/dev/null 2>&1
}

run_remote() {
  alias_name="$1"
  shift
  [ "${1:-}" = "--" ] && shift

  # Fail at the network boundary before attempting multiple auth methods.
  host="$(profile_value "$alias_name" hostname)"
  port="$(profile_value "$alias_name" port)"
  [ -n "$host" ] || die "profile not found: $alias_name"
  openclaude-ssh-doctor "$host" "${port:-22}" --timeout-ms "$((CONNECT_TIMEOUT * 1000))" --strict

  if key_ready "$alias_name"; then
    ssh_base "$alias_name" "$@"
    exit $?
  fi

  password_file="$STATE_DIR/secrets/$alias_name.password"
  [ -r "$password_file" ] || die "key auth failed and password file is missing: $password_file"
  exec sshpass -f "$password_file" ssh -F "$STATE_DIR/config" \
    -o "ConnectTimeout=$CONNECT_TIMEOUT" \
    -o ConnectionAttempts=2 \
    -o PreferredAuthentications=password,keyboard-interactive \
    -o PubkeyAuthentication=no \
    "$alias_name" "$@"
}

command="${1:-help}"
shift || true
prepare_state

case "$command" in
  init)
    alias_name="${1:-$PROFILE}"
    host="${2:-}"
    user="${3:-root}"
    port="${4:-22}"
    validate_name "$alias_name"
    validate_name "$user"
    [ -n "$host" ] || die 'usage: openclaude-ssh init <profile> <host> [user] [port]'
    validate_port "$port"
    key="$STATE_DIR/id_${alias_name}_ed25519"
    if [ ! -f "$key" ]; then
      ssh-keygen -q -t ed25519 -N '' -C "openclaude@$alias_name" -f "$key"
    fi
    cat > "$STATE_DIR/config.d/$alias_name.conf" <<EOF
Host $alias_name
  HostName $host
  User $user
  Port $port
  IdentityFile $key
  IdentitiesOnly yes
  UserKnownHostsFile $STATE_DIR/known_hosts
  StrictHostKeyChecking accept-new
  ConnectTimeout $CONNECT_TIMEOUT
  ConnectionAttempts 2
  ServerAliveInterval 15
  ServerAliveCountMax 3
  TCPKeepAlive yes
EOF
    chmod 600 "$STATE_DIR/config.d/$alias_name.conf" "$key" 2>/dev/null || true
    chmod 644 "$key.pub" 2>/dev/null || true
    printf 'Profile %s -> %s@%s:%s\n' "$alias_name" "$user" "$host" "$port"
    printf 'Public key: %s.pub\n' "$key"
    ;;
  doctor)
    doctor "${1:-$PROFILE}"
    ;;
  public-key)
    alias_name="${1:-$PROFILE}"
    cat "$STATE_DIR/id_${alias_name}_ed25519.pub"
    ;;
  bootstrap-key)
    alias_name="${1:-$PROFILE}"
    host="$(profile_value "$alias_name" hostname)"
    user="$(profile_value "$alias_name" user)"
    port="$(profile_value "$alias_name" port)"
    [ -n "$host" ] || die "profile not found: $alias_name"
    openclaude-ssh-doctor "$host" "${port:-22}" --timeout-ms "$((CONNECT_TIMEOUT * 1000))" --strict
    password_file="$STATE_DIR/secrets/$alias_name.password"
    [ -r "$password_file" ] || die "password file is missing: $password_file"
    sshpass -f "$password_file" ssh-copy-id \
      -i "$STATE_DIR/id_${alias_name}_ed25519.pub" \
      -p "${port:-22}" \
      -o "UserKnownHostsFile=$STATE_DIR/known_hosts" \
      -o StrictHostKeyChecking=accept-new \
      "${user:-root}@$host"
    ssh -F "$STATE_DIR/config" -o BatchMode=yes "$alias_name" true
    printf 'Key authentication verified for %s.\n' "$alias_name"
    ;;
  run)
    alias_name="${1:-$PROFILE}"
    shift || true
    run_remote "$alias_name" "$@"
    ;;
  connect)
    run_remote "${1:-$PROFILE}"
    ;;
  watch)
    alias_name="${1:-$PROFILE}"
    interval="${OPENCLAUDE_SSH_RETRY_SECONDS:-300}"
    case "$interval" in
      ''|*[!0-9]*) die "invalid retry interval: $interval" ;;
    esac
    [ "$interval" -ge 30 ] || die 'retry interval must be at least 30 seconds'
    validate_name "$alias_name"
    last_state=''
    while :; do
      state='blocked'
      if key_ready "$alias_name"; then
        state='ready'
      elif [ -r "$STATE_DIR/secrets/$alias_name.password" ]; then
        if "$0" bootstrap-key "$alias_name" >/dev/null 2>&1; then
          rm -f "$STATE_DIR/secrets/$alias_name.password"
          state='recovered-key-auth'
        fi
      else
        state='waiting-without-bootstrap-password'
      fi
      if [ "$state" != "$last_state" ]; then
        printf '%s profile=%s state=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$alias_name" "$state"
        last_state="$state"
      fi
      sleep "$interval"
    done
    ;;
  help|-h|--help)
    cat <<'EOF'
Usage:
  openclaude-ssh init <profile> <host> [user] [port]
  openclaude-ssh doctor [profile]
  openclaude-ssh public-key [profile]
  openclaude-ssh bootstrap-key [profile]
  openclaude-ssh run [profile] -- <command...>
  openclaude-ssh connect [profile]
  openclaude-ssh watch [profile]

Store a bootstrap password only in:
  $OPENCLAUDE_SSH_STATE_DIR/secrets/<profile>.password

The password is never accepted as a command-line argument. After
bootstrap-key succeeds, remove the password file and use the persistent key.
EOF
    ;;
  *)
    die "unknown command: $command"
    ;;
esac
