#!/bin/bash
set -euo pipefail

rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
mkdir -p "$HOME/.vnc"

security_args=(-SecurityTypes None --I-KNOW-THIS-IS-INSECURE)
if [[ -n "${VNC_PW:-}" ]]; then
    printf '%s\n' "$VNC_PW" | vncpasswd -f > "$HOME/.vnc/passwd"
    chmod 0600 "$HOME/.vnc/passwd"
    security_args=(-SecurityTypes VncAuth -rfbauth "$HOME/.vnc/passwd")
fi

vncserver :1 \
    -geometry "${VNC_RESOLUTION:-1280x900}" \
    -depth "${VNC_COL_DEPTH:-24}" \
    -rfbport "${VNC_PORT:-5901}" \
    -localhost no \
    "${security_args[@]}" \
    -AlwaysShared \
    -AcceptPointerEvents \
    -AcceptKeyEvents \
    -AcceptCutText \
    -SendCutText \
    -xstartup /usr/local/bin/xstartup.sh

exec tail -F "$HOME"/.vnc/*.log
