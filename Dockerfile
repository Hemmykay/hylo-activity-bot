# Hylo Asset Live Bot — production image for Dokploy.
#
# Runs the TypeScript source directly through tsx (same loader used in dev,
# WITHOUT --watch): the tsc/dist path is not used because tsc neither rewrites
# the `@/*` path aliases nor copies the IDL JSON into dist. Full deps are kept
# because `prisma migrate deploy` runs in the container at startup.
FROM node:22-slim
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src

# Migrations apply on boot, then the bot starts (no --watch in production).
CMD ["sh", "-c", "npx prisma migrate deploy && node --import tsx/esm src/index.ts"]
