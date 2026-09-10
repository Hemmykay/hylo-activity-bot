import { faqRepository } from '@/db/repositories/faq.repository.js';
import type { ISearchAdapter, SearchResult } from '../search.types.js';

export class PostgresFTSAdapter implements ISearchAdapter {
  async search(query: string, limit = 10): Promise<SearchResult[]> {
    const rows = await faqRepository.fullTextSearch(query, limit);
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      question: row.question,
      answer: row.answer,
      category: row.category,
      tags: row.tags,
      score: Number(row.rank),
    }));
  }
}
