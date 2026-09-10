import { prisma } from '../prisma.js';

export interface CreateSearchLogInput {
  query: string;
  resultCount: number;
  topScore?: number | undefined;
  actorId: string;
}

export const searchLogRepository = {
  async create(data: CreateSearchLogInput): Promise<void> {
    await prisma.searchLog.create({
      data: {
        query: data.query,
        resultCount: data.resultCount,
        topScore: data.topScore ?? null,
        actorId: data.actorId,
      },
    });
  },
};
