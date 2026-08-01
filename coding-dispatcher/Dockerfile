FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    LANG=C.UTF-8

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10004 dispatcher \
    && useradd --uid 10004 --gid 10004 --create-home --home-dir /home/dispatcher dispatcher

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules

USER 10004:10004
ENTRYPOINT ["node", "dist/index.js"]
