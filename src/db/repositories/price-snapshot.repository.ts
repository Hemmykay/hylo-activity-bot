import { prisma } from '../prisma.js';

const MAX_AGE_MS = 48 * 60 * 60 * 1000; // only ever need ~24h of lookback + margin

export const priceSnapshotRepository = {
  /** Records one price point, then opportunistically prunes this symbol's history past MAX_AGE_MS. */
  async record(symbol: string, price: number): Promise<void> {
    await prisma.priceSnapshot.create({ data: { symbol, price } });
    await prisma.priceSnapshot.deleteMany({
      where: { symbol, capturedAt: { lt: new Date(Date.now() - MAX_AGE_MS) } },
    });
  },

  /**
   * The snapshot closest to (at or before) 24h ago for this symbol — the
   * comparison point for a 24h-change display. Null if there's no snapshot
   * that old yet (e.g. this symbol's ticker only started running recently).
   */
  async findNear24hAgo(symbol: string): Promise<{ price: number; capturedAt: Date } | null> {
    const targetDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const snapshot = await prisma.priceSnapshot.findFirst({
      where: { symbol, capturedAt: { lte: targetDate } },
      orderBy: { capturedAt: 'desc' },
      select: { price: true, capturedAt: true },
    });
    return snapshot;
  },
};
