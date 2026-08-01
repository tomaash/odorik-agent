FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim

ARG GROK_VERSION=0.2.117
ENV NODE_ENV=production \
    LANG=C.UTF-8

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@xai-official/grok@${GROK_VERSION}" \
    && groupadd --gid 10003 grok-auth \
    && useradd --uid 10003 --gid 10003 --create-home --home-dir /home/grok-auth grok-auth \
    && install -d -o root -g root -m 0755 /app /etc/grok \
    && install -d -o 10003 -g 10003 -m 0700 /home/grok-auth/.grok \
    && chown -R 10003:10003 /home/grok-auth \
    && GROK_HOME=/tmp/grok-build-home grok --version

ENV HOME=/home/grok-auth \
    GROK_HOME=/home/grok-auth/.grok

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY grok/requirements.toml /etc/grok/requirements.toml
RUN chown root:root /etc/grok/requirements.toml \
    && chmod 0444 /etc/grok/requirements.toml

USER 10003:10003
ENTRYPOINT ["node", "dist/index.js"]
