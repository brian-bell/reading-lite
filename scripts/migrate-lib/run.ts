import { promises as fs } from "node:fs";
import path from "node:path";
import {
  BacklitRowSchema,
  planReading,
  type BacklitRow,
} from "./plan";
import type { R2Client, VectorizeClient } from "./clients";

export interface MigrationDeps {
  r2: R2Client;
  vectorize: VectorizeClient;
  contentDir: string;
  log?: (line: string) => void;
}

export interface MigrationReportRow {
  id: string;
  status: "ok" | "error" | "skipped";
  error?: string;
}

export async function migrateOne(
  row: BacklitRow,
  deps: MigrationDeps,
): Promise<MigrationReportRow> {
  const planned = planReading(row);
  try {
    // 1. Manifest
    await deps.r2.put(`${planned.keyPrefix}/manifest.json`, JSON.stringify(planned.manifest), {
      contentType: "application/json",
    });

    // 2. Raw bytes — read from `{contentDir}/readings/{id}/raw.{ext}` if present.
    const rawPath = path.join(deps.contentDir, "readings", row.id, `raw.${planned.rawExt}`);
    const rawBytes = await readIfExists(rawPath);
    if (rawBytes) {
      await deps.r2.put(`${planned.keyPrefix}/raw.${planned.rawExt}`, rawBytes, {
        contentType: row.content_type,
      });
    }

    // 3. Extracted markdown — read from `{contentDir}/readings/{id}/extracted.md` if present.
    if (row.content_status === "captured") {
      const extractedPath = path.join(deps.contentDir, "readings", row.id, "extracted.md");
      const extractedBytes = await readIfExists(extractedPath);
      if (extractedBytes) {
        await deps.r2.put(`${planned.keyPrefix}/extracted.md`, extractedBytes, {
          contentType: "text/markdown; charset=utf-8",
        });
      }
    }

    // 4. by-url + by-id pointers
    const pointerJson = JSON.stringify({ id: row.id, key_prefix: planned.keyPrefix });
    await deps.r2.put(`index/by-url/${row.url_hash}`, pointerJson, {
      contentType: "application/json",
    });
    await deps.r2.put(`index/by-id/${row.id}`, pointerJson, {
      contentType: "application/json",
    });

    // 5. Vectorize upsert
    await deps.vectorize.upsert([
      {
        id: row.id,
        values: planned.embedding,
        metadata: vectorMetadata(planned.manifest),
      },
    ]);

    return { id: row.id, status: "ok" };
  } catch (e) {
    return {
      id: row.id,
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function runMigration(
  rows: Iterable<unknown>,
  deps: MigrationDeps,
): Promise<MigrationReportRow[]> {
  const log = deps.log ?? ((line: string) => process.stdout.write(line + "\n"));
  log("id,status,error");
  const report: MigrationReportRow[] = [];
  for (const raw of rows) {
    const parsed = BacklitRowSchema.safeParse(raw);
    if (!parsed.success) {
      const id = (raw as { id?: string })?.id ?? "(unknown)";
      const r: MigrationReportRow = {
        id,
        status: "error",
        error: `row failed schema: ${parsed.error.message}`,
      };
      report.push(r);
      log(csvRow(r));
      continue;
    }
    const r = await migrateOne(parsed.data, deps);
    report.push(r);
    log(csvRow(r));
  }
  return report;
}

function csvRow(r: MigrationReportRow): string {
  const err = (r.error ?? "").replace(/"/g, '""');
  return `${r.id},${r.status},"${err}"`;
}

function vectorMetadata(m: { url: string; title?: string; tags?: string[]; created_at: string }) {
  const out: Record<string, string | number | boolean | string[]> = {
    url: m.url,
    created_at: m.created_at,
  };
  if (m.title) out.title = m.title;
  if (m.tags) out.tags = m.tags;
  return out;
}

async function readIfExists(p: string): Promise<Uint8Array | null> {
  try {
    const buf = await fs.readFile(p);
    return new Uint8Array(buf);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
