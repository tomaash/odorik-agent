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
    LANG=C.UTF-8 \
    GROK_HOME=/home/grok/.grok \
    GROK_SANDBOX=workspace \
    WORKSPACE_ROOT=/workspace

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      bubblewrap \
      ca-certificates \
      g++ \
      git \
      make \
      python3 \
      ripgrep \
      tar \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@xai-official/grok@${GROK_VERSION}" \
    && groupadd --gid 10002 workspace \
    && useradd --uid 10001 --gid 10002 --create-home --home-dir /home/grok grok \
    && useradd --uid 10002 --gid 10002 --create-home --home-dir /home/workspace workspace \
    && chown -R 10001:10002 /home/grok \
    && chown -R 10002:10002 /home/workspace \
    && install -d -o root -g root -m 0755 /app /etc/grok \
    && grok --version

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY grok/requirements.toml /etc/grok/requirements.toml
RUN chown root:root /etc/grok/requirements.toml \
    && chmod 0444 /etc/grok/requirements.toml

# grok inspect initializes the Linux sandbox, which is intentionally unavailable
# in Docker's image builder. The runner performs the inspection in Cloud Run's
# second-generation execution environment before it starts an agent session.

ENTRYPOINT ["node", "dist/index.js"]
