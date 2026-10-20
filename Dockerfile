# syntax=docker/dockerfile:1
#
# 生产构建：干净的 node_modules + 显式安装 devDependencies。
# 不要再让平台在已有 node_modules 的 /app 上跑 `npm ci`：
# npm ci 会先整目录删除，Railway/Nixpacks 的缓存层会因此报
# `EBUSY: resource busy or locked, rmdir '/app/node_modules/.cache'`。

FROM node:22-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
# Prisma 的查询/迁移引擎在 Debian slim 上需要 libssl。
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
# 构建期平台常注入 NODE_ENV=production；不显式带 dev 会漏掉
# prisma / typescript / tailwind，next build 必失败。
RUN npm ci --include=dev --no-audit --no-fund

FROM base AS build
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/next.config.ts ./next.config.ts

RUN chown -R node:node /app
USER node

EXPOSE 3000
CMD ["sh", "-c", "if [ -n \"$DIRECT_URL\" ]; then npx prisma migrate deploy; fi; exec npm run start"]
