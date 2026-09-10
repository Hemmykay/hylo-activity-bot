# Hylo Asset Live Bot — production image for Dokploy.
#
# Runs the TypeScript source directly through tsx (same loader used in dev,
# WITHOUT --watch): the tsc/dist path is not used because tsc neither rewrites
# the `@/*` path aliases nor copies the IDL JSON into dist. Full deps are kept
# because `prisma migrate deploy` runs in the container at startup.
FROM node:22-slim
WORKDIR /app

ENV NODE_ENV=production

# Prisma's engines need the OpenSSL CLI/libs, which -slim images omit —
# without this, `prisma migrate deploy` dies with "Schema engine error".
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# --include=dev: tsx and the prisma CLI are devDependencies but both run in
# production (NODE_ENV=production would otherwise make npm skip them).
RUN npm ci --include=dev

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src

# Migrations apply on boot, then the bot starts (no --watch in production).
CMD ["sh", "-c", "npx prisma migrate deploy && node --import tsx/esm src/index.ts"]
