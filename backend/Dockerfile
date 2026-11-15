# RAVZO API + worker — image de production
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && apt-get clean
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev && npx prisma generate

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini && apt-get clean \
 && useradd -r -u 10001 -g node ravzo && mkdir -p /app/storage /app/secrets && chown -R ravzo:node /app
ENV NODE_ENV=production
COPY --from=build --chown=ravzo:node /app/node_modules ./node_modules
COPY --from=build --chown=ravzo:node /app/dist ./dist
COPY --from=build --chown=ravzo:node /app/prisma ./prisma
COPY --chown=ravzo:node package.json ./
USER ravzo
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/src/main.js"]
