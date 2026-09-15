export declare const LIBRARY_PAGE_SIZE: number;

export interface LibraryPageBody<T> {
  readings: T[];
  limit: number;
  offset: number;
  has_more: boolean;
}

export declare function libraryPage<T extends { url: string; created_at: string }>(
  items: readonly T[],
  params?: { q?: string; tag?: string; offset?: number },
): LibraryPageBody<T>;
