import { prisma } from '../prisma.js';

/** Durable progress markers for the watchers (see WatcherState in schema.prisma). All calls are best-effort for the caller to wrap. */
export const watcherStateRepository = {
  async get(key: string): Promise<string | null> {
    const row = await prisma.watcherState.findUnique({ where: { key } });
    return row?.value ?? null;
  },

  async getMany(prefix: string): Promise<Array<{ key: string; value: string; updatedAt: Date }>> {
    return prisma.watcherState.findMany({ where: { key: { startsWith: prefix } } });
  },

  async set(key: string, value: string): Promise<void> {
    await prisma.watcherState.upsert({ where: { key }, create: { key, value }, update: { value } });
  },
};

/** Alert de-duplication (see AlertedEvent in schema.prisma). */
export const alertedEventRepository = {
  /** True exactly once per key: the caller that gets true is the one that should post the alert. */
  async claim(key: string): Promise<boolean> {
    const r = await prisma.alertedEvent.createMany({ data: [{ key }], skipDuplicates: true });
    return r.count === 1;
  },

  /** Gives a claim back (e.g. the Discord send failed) so a later pass can still announce the event. */
  async release(key: string): Promise<void> {
    await prisma.alertedEvent.deleteMany({ where: { key } });
  },

  async prune(olderThan: Date): Promise<number> {
    const r = await prisma.alertedEvent.deleteMany({ where: { createdAt: { lt: olderThan } } });
    return r.count;
  },
};
