export interface ReadingPointer {
  id: string;
  key_prefix: string;
}

export function readingPointer(id: string, keyPrefix: string): ReadingPointer {
  return { id, key_prefix: keyPrefix };
}

export function serializeReadingPointer(id: string, keyPrefix: string): string {
  return JSON.stringify(readingPointer(id, keyPrefix));
}
