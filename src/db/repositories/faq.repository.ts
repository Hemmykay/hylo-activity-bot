import type { FAQ, Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';

export type CreateFAQInput = Omit<FAQ, 'id' | 'createdAt' | 'updatedAt' | 'isActive'>;
export type UpdateFAQInput = Partial<CreateFAQInput>;

export const faqRepository = {
  async findById(id: string): Promise<FAQ | null> {
    return prisma.fAQ.findUnique({ where: { id } });
  },

  async findAll(options?: { category?: string | undefined; activeOnly?: boolean | undefined }): Promise<FAQ[]> {
    const where: Prisma.FAQWhereInput = {};

    if (options?.activeOnly !== false) {
      where.isActive = true;
    }
    if (options?.category) {
      where.category = options.category;
    }

    return prisma.fAQ.findMany({
      where,
      orderBy: [{ category: 'asc' }, { title: 'asc' }],
    });
  },

  async create(data: CreateFAQInput): Promise<FAQ> {
    return prisma.fAQ.create({ data });
  },

  async update(id: string, data: UpdateFAQInput): Promise<FAQ> {
    return prisma.fAQ.update({ where: { id }, data });
  },

  async softDelete(id: string): Promise<FAQ> {
    return prisma.fAQ.update({ where: { id }, data: { isActive: false } });
  },

  async hardDelete(id: string): Promise<FAQ> {
    return prisma.fAQ.delete({ where: { id } });
  },

  /** Finds a single FAQ whose cuid ends with `shortId` (the last 6+ chars shown in /faq list). */
  async findByShortId(shortId: string): Promise<FAQ | null> {
    const results = await prisma.fAQ.findMany({
      where: { id: { endsWith: shortId }, isActive: true },
      take: 2,
    });
    if (results.length === 1) return results[0]!;
    if (results.length > 1) throw new Error(`Multiple FAQs match \`${shortId}\` — use a longer ID fragment`);
    return null;
  },

  /**
   * Lightweight search used by autocomplete dropdowns.
   * Returns up to 25 active FAQs whose title, category, or question contains
   * the query string (case-insensitive). Empty query returns the 25 most
   * recently updated FAQs so the list is immediately useful.
   */
  async searchForAutocomplete(query: string): Promise<FAQ[]> {
    if (!query.trim()) {
      return prisma.fAQ.findMany({
        where: { isActive: true },
        orderBy: { updatedAt: 'desc' },
        take: 25,
      });
    }

    return prisma.fAQ.findMany({
      where: {
        isActive: true,
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { category: { contains: query, mode: 'insensitive' } },
          { question: { contains: query, mode: 'insensitive' } },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: 25,
    });
  },

  async listCategories(): Promise<string[]> {
    const results = await prisma.fAQ.findMany({
      where: { isActive: true },
      select: { category: true },
      distinct: ['category'],
      orderBy: { category: 'asc' },
    });
    return results.map((r) => r.category);
  },

  /**
   * PostgreSQL full-text search across title, question, answer, and keywords.
   * Returns FAQs ranked by text search relevance.
   */
  async fullTextSearch(query: string, limit = 10): Promise<Array<FAQ & { rank: number }>> {
    // Sanitise input — strip characters Postgres tsquery doesn't accept
    const sanitised = query
      .replace(/[^\w\s]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => `${word}:*`) // prefix matching
      .join(' & ');

    if (!sanitised) return [];

    // Raw query because Prisma doesn't expose ts_rank natively
    const results = await prisma.$queryRaw<Array<FAQ & { rank: number }>>`
      SELECT *,
        ts_rank(
          to_tsvector('english',
            coalesce(title, '') || ' ' ||
            coalesce(question, '') || ' ' ||
            coalesce(answer, '') || ' ' ||
            array_to_string(keywords, ' ')
          ),
          to_tsquery('english', ${sanitised})
        ) AS rank
      FROM faqs
      WHERE "isActive" = true
        AND to_tsvector('english',
              coalesce(title, '') || ' ' ||
              coalesce(question, '') || ' ' ||
              coalesce(answer, '') || ' ' ||
              array_to_string(keywords, ' ')
            ) @@ to_tsquery('english', ${sanitised})
      ORDER BY rank DESC
      LIMIT ${limit}
    `;

    return results;
  },
};
