import { createLogger } from '@/lib/logger.js';
import { searchLogRepository } from '@/db/repositories/search-log.repository.js';
import { PostgresFTSAdapter } from './adapters/postgres-fts.adapter.js';
import type { ISearchAdapter, SearchResult } from './search.types.js';

const logger = createLogger('search-service');

class SearchService {
  private adapter: ISearchAdapter;

  constructor(adapter: ISearchAdapter = new PostgresFTSAdapter()) {
    this.adapter = adapter;
  }

  async search(query: string, actorId: string, limit = 10): Promise<SearchResult[]> {
    logger.debug({ query, limit }, 'FAQ search');

    const results = await this.adapter.search(query, limit);

    await searchLogRepository.create({
      query,
      resultCount: results.length,
      topScore: results[0]?.score,
      actorId,
    });

    logger.debug({ count: results.length, topScore: results[0]?.score }, 'Search complete');
    return results;
  }
}

export const searchService = new SearchService();
