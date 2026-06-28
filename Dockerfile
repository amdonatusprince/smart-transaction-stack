FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile \
  && pnpm rebuild better-sqlite3

COPY . .

RUN pnpm run build:article \
  && chmod +x scripts/railway-start.sh

ENV NODE_ENV=production
ENV DB_PATH=/data/txstack.sqlite

EXPOSE 8787

CMD ["bash", "scripts/railway-start.sh"]
