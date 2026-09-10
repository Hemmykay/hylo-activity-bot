export interface SearchResult {
  id: string;
  title: string;
  question: string;
  answer: string;
  category: string;
  tags: string[];
  score: number;
}

export interface ISearchAdapter {
  search(query: string, limit?: number): Promise<SearchResult[]>;
}
