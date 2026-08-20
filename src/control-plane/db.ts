export interface SqlStatement {
  sql: string;
  params: readonly unknown[];
}

export interface ControlPlaneDb {
  first<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  all<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  batch(statements: readonly SqlStatement[]): Promise<void>;
}

export function fromD1(d1: D1Database): ControlPlaneDb {
  return {
    async first<T>(sql: string, ...params: unknown[]) {
      return (await d1.prepare(sql).bind(...params).first<T>()) ?? null;
    },
    async all<T>(sql: string, ...params: unknown[]) {
      const result = await d1.prepare(sql).bind(...params).all<T>();
      return result.results;
    },
    async batch(statements) {
      if (statements.length === 0) return;
      await d1.batch(statements.map((statement) => d1.prepare(statement.sql).bind(...statement.params)));
    },
  };
}
