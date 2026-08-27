FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock* ./

RUN bun install --frozen-lockfile

COPY . .

RUN bunx prisma generate

CMD ["bun", "run", "apps/engine/index.ts"]