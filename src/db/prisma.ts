import { PrismaClient } from '@prisma/client';
import { createLogger } from '@/lib/logger.js';

const logger = createLogger('prisma');

// Per-query logging isn't wired up — it fires on every single DB call, which
// is far too noisy for routine use. Turn `{ emit: 'event', level: 'query' }`
// back on here (and re-add a prisma.$on('query', ...) listener below) if
// actively debugging a specific query.
const prisma = new PrismaClient({
  log: [
    { emit: 'event', level: 'warn' },
    { emit: 'event', level: 'error' },
  ],
});

prisma.$on('warn', (e) => {
  logger.warn({ message: e.message }, 'Prisma warning');
});

prisma.$on('error', (e) => {
  logger.error({ message: e.message }, 'Prisma error');
});

export { prisma };
