# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NODE_IMAGE=node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03
ARG APP_VERSION=0.1.0

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM dependencies AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM ${NODE_IMAGE} AS runtime
ARG APP_VERSION
WORKDIR /app

LABEL org.opencontainers.image.title="PerPay" \
      org.opencontainers.image.description="Self-hosted collection-code payment service" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV NODE_ENV=production \
    PERPAY_HOST=0.0.0.0 \
    PERPAY_PORT=8080 \
    PERPAY_DATA_DIR=/data

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node LICENSE NOTICE ./
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5m --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "dist/main.js"]
