export type SearchAdminOverview = {
  meili: {
    indexName: string;
    numberOfDocuments: number | null;
    isIndexing: boolean | null;
    fieldDistribution: Record<string, number> | null;
    settings: {
      searchableAttributes: string[] | null;
      filterableAttributes: string[] | null;
      sortableAttributes: string[] | null;
      synonymCount: number | null;
    };
  };
  selectionSignals: {
    scanned: number;
    top: {
      q: string;
      symbol: string;
      count: number;
    }[];
  };
  popularQueries: {
    q: string;
    totalSelections: number;
    uniqueSymbols: number;
  }[];
  errors: string[];
  generatedAt: string;
};
export declare class AdminSearchService {
  private readonly logger;
  private readonly meili;
  private readonly redis?;
  constructor();
  getOverview(topN?: number): Promise<SearchAdminOverview>;
  private fetchMeiliBlock;
  private emptyMeiliBlock;
  private fetchSelectionSignals;
}
