FROM python:3.12-slim-bookworm

LABEL org.opencontainers.image.title="Cua Desktop Pool XFCE"
LABEL org.opencontainers.image.source="https://github.com/trycua/cua"
LABEL cua.desktop-pool.variant="lean-computer-server"

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/home/cua \
    DISPLAY=:1 \
    VNC_PORT=5901 \
    NOVNC_PORT=6901 \
    API_PORT=8000 \
    VNC_RESOLUTION=1280x900 \
    VNC_COL_DEPTH=24 \
    PYTHONUNBUFFERED=1

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    dbus-x11 \
    firefox-esr \
    fonts-dejavu-core \
    netcat-openbsd \
    novnc \
    procps \
    sudo \
    supervisor \
    tigervnc-standalone-server \
    tigervnc-tools \
    websockify \
    x11-utils \
    x11-xserver-utils \
    xclip \
    xdg-utils \
    xfce4 \
    xfce4-terminal \
    && apt-get clean \
    && find /var/lib/apt/lists -mindepth 1 -delete

RUN --mount=type=cache,target=/root/.cache/pip \
    apt-get update \
    && apt-get install -y --no-install-recommends gcc libc6-dev linux-libc-dev \
    && python -m pip install --upgrade pip \
    && python -m pip install "cua-computer-server==0.3.42" \
    && apt-get purge -y --auto-remove gcc libc6-dev linux-libc-dev \
    && apt-get clean \
    && find /var/lib/apt/lists -mindepth 1 -delete

RUN useradd --create-home --shell /bin/bash --groups sudo cua \
    && echo "cua ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/cua \
    && chmod 0440 /etc/sudoers.d/cua \
    && mkdir -p /home/cua/.config/autostart /home/cua/.mozilla/firefox /home/cua/.vnc \
    && chown -R cua:cua /home/cua

RUN printf '%s\n' \
      'pref("datareporting.policy.firstRunURL", "");' \
      'pref("datareporting.policy.dataSubmissionEnabled", false);' \
      'pref("browser.aboutwelcome.enabled", false);' \
      > /etc/firefox-esr/cua.js

COPY docker/supervisord.conf /etc/supervisor/supervisord.conf
COPY docker/start-vnc.sh /usr/local/bin/start-vnc.sh
COPY docker/start-novnc.sh /usr/local/bin/start-novnc.sh
COPY docker/start-computer-server.sh /usr/local/bin/start-computer-server.sh
COPY docker/xstartup.sh /usr/local/bin/xstartup.sh

RUN chmod 0755 /usr/local/bin/start-vnc.sh \
    /usr/local/bin/start-novnc.sh \
    /usr/local/bin/start-computer-server.sh \
    /usr/local/bin/xstartup.sh \
    && grep -q -- "--host 0.0.0.0" /usr/local/bin/start-computer-server.sh

WORKDIR /home/cua

EXPOSE 5901 6901 8000

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=12 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/status', timeout=3)" || exit 1

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/supervisord.conf"]
