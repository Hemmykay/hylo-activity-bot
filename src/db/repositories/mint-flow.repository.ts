import type { FlowKind } from '@prisma/client';
import { prisma } from '../prisma.js';

export interface FlowTotals {
  mint: number;
  burn: number;
}

export interface FlowSummary {
  // Earliest event still in the table when summarized — null if it was empty
  // (e.g. the very first window, or a quiet 24h with no on-chain activity).
  windowStart: Date | null;
  totals: Map<string, FlowTotals>;
}

async function aggregate(client: Pick<typeof prisma.mintFlowEvent, 'groupBy' | 'findFirst'>): Promise<FlowSummary> {
  const [grouped, oldest] = await Promise.all([
    client.groupBy({ by: ['symbol', 'kind'], _sum: { amount: true } }),
    client.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
  ]);

  const totals = new Map<string, FlowTotals>();
  for (const row of grouped) {
    const entry = totals.get(row.symbol) ?? { mint: 0, burn: 0 };
    const amount = row._sum.amount ?? 0;
    if (row.kind === 'MINT') entry.mint += amount;
    else entry.burn += amount;
    totals.set(row.symbol, entry);
  }

  return { windowStart: oldest?.createdAt ?? null, totals };
}

export const mintFlowRepository = {
  /** Records one detected mint/burn amount. No-ops on non-positive amounts — there's nothing to accumulate. */
  async record(symbol: string, kind: FlowKind, amount: number): Promise<void> {
    if (!(amount > 0)) return;
    await prisma.mintFlowEvent.create({ data: { symbol, kind, amount } });
  },

  /** Read-only aggregation — for previewing what the next real summary would say, without disturbing the rolling window. */
  async summarize(): Promise<FlowSummary> {
    return aggregate(prisma.mintFlowEvent);
  },

  /**
   * Sums everything currently in the table by symbol/kind, then wipes it —
   * this is a rolling window, not a permanent ledger, so once a day's totals
   * are read they're gone. Runs as one transaction so a crash between the
   * read and the delete can't happen.
   */
  async summarizeAndClear(): Promise<FlowSummary> {
    return prisma.$transaction(async (tx) => {
      const summary = await aggregate(tx.mintFlowEvent);
      await tx.mintFlowEvent.deleteMany({});
      return summary;
    });
  },
};
