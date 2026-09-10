import type { Correction } from '@prisma/client';
import { prisma } from '../prisma.js';

export type CreateCorrectionInput = {
  actorId: string;
  actorName: string;
  originalQuestion: string;
  wrongBotAnswer: string;
  rawCorrection: string;
};

export type MarkStructuredInput = {
  faqAction: 'created' | 'updated' | 'no_change';
  faqTitle?: string | undefined;
};

export const correctionRepository = {
  async create(data: CreateCorrectionInput): Promise<Correction> {
    return prisma.correction.create({ data });
  },

  async markStructured(id: string, data: MarkStructuredInput): Promise<Correction> {
    return prisma.correction.update({
      where: { id },
      data: {
        structured: true,
        faqAction: data.faqAction,
        ...(data.faqTitle !== undefined && { faqTitle: data.faqTitle }),
      },
    });
  },

  async findMany(options?: {
    structuredOnly?: boolean;
    unstructuredOnly?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<Correction[]> {
    const where =
      options?.unstructuredOnly ? { structured: false }
      : options?.structuredOnly ? { structured: true }
      : {};
    return prisma.correction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: options?.limit ?? 10,
      skip: options?.offset ?? 0,
    });
  },

  async count(options?: { unstructuredOnly?: boolean }): Promise<number> {
    return prisma.correction.count({
      where: options?.unstructuredOnly ? { structured: false } : {},
    });
  },
};
