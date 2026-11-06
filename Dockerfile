FROM mcr.microsoft.com/playwright:v1.64.1-jammy

# Desktop dependencies include tzdata; remote builds have no interactive terminal.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC apt-get install -y --no-install-recommends \
       xvfb x11vnc novnc websockify openbox xauth x11-utils x11-xserver-utils tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 xbrowser \
    && useradd --uid 1001 --gid 1001 --no-create-home --shell /usr/sbin/nologin xbrowser \
    && useradd --uid 1002 --gid 1001 --no-create-home --shell /usr/sbin/nologin xdesktop

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
COPY scripts/start-desktop.sh /usr/local/bin/start-x-login
COPY docker/openbox.xml /etc/x-login-desktop/openbox.xml

# The streamed browser cannot read backend source, .env, or tenant storage.
# Its worker needs only the two Playwright packages, copied read-only elsewhere.
RUN mkdir -p /opt/x-login-worker/node_modules /var/lib/x-engine \
    && cp scripts/desktop-browser-server.cjs /opt/x-login-worker/ \
    && cp -a node_modules/playwright node_modules/playwright-core /opt/x-login-worker/node_modules/ \
    && chmod -R a+rX /opt/x-login-worker /ms-playwright \
    && chmod -R go-rwx /usr/src/app \
    && chmod 700 /var/lib/x-engine \
    && chmod 755 /usr/local/bin/start-x-login

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/var/lib/x-engine
ENV DISPLAY=:99

# VNC (5900) and websockify (6080) bind ONLY to loopback; Node gates access.
EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/start-x-login"]
