export declare const LIBRARY_PAGE_SIZE: number;
export declare const ARCHIVE_ROW_COUNT: number;

export interface ArchiveRow {
  id: string;
  key_prefix: string;
  url: string;
  status: "ready";
  created_at: string;
  updated_at: string;
  title: string;
  tldr: string;
  tags: string[];
  keywords: string[];
}

export declare function libraryItems<T extends { created_at: string }>(items: readonly T[]): (T | ArchiveRow)[];

export interface LibraryPageBody<T> {
  readings: T[];
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface CatalogFacet {
  kind: "people" | "orgs" | "keywords" | "hosts";
  term: string;
}

export declare function withReadingTerms<T extends { id: string }>(
  items: readonly T[],
  readings: Readonly<
    Record<string, { id: string; people?: readonly string[]; orgs?: readonly string[]; keywords?: readonly string[] }>
  >,
): T[];

export declare function libraryPage<T extends { url: string; created_at: string }>(
  items: readonly T[],
  params?: { q?: string; tag?: string; offset?: number; facet?: CatalogFacet },
): LibraryPageBody<T>;
