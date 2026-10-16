import { z } from "zod";
import { ApiError } from "./api/errors";
import type { AccountRead } from "./account-state";
import type { LibraryParams } from "./library";
import { offsetParam, snapOffset } from "./library-search";
import { actingTenantOf, messageOf } from "./reading";
import { forwardedFrom, type BackendReads } from "./server/backend-reads";

export const TERM_KINDS = ["people", "orgs", "keywords", "hosts"] as const;
export type TermKind = (typeof TERM_KINDS)[number];

export const KINDS = {
  people: { param: "person", label: "People" },
  orgs: { param: "org", label: "Organizations" },
  keywords: { param: "keyword", label: "Keywords" },
  hosts: { param: "host", label: "Hosts" },
} as const satisfies Record<TermKind, { param: "person" | "org" | "keyword" | "host"; label: string }>;

export type FacetParam = (typeof KINDS)[TermKind]["param"];

export interface Facet {
  kind: TermKind;
  term: string;
}

export type CatalogView =
  | { mode: "index"; kind: TermKind }
  | { mode: "term"; facet: Facet; q?: string; offset: number }
  | { mode: "text"; q: string; kind: TermKind; offset: number };

export type CatalogListView = Extract<CatalogView, { mode: "term" | "text" }>;

export interface CatalogSearch {
  kind?: string;
  q?: string;
  offset?: string;
  person?: string;
  org?: string;
  keyword?: string;
  host?: string;
  [other: string]: string | undefined;
}

const CATALOG_PARAMS = ["kind", "q", "offset", "person", "org", "keyword", "host"] as const;

export function validateCatalogSearch(search: Record<string, unknown>): CatalogSearch {
  const out: CatalogSearch = {};
  for (const name of CATALOG_PARAMS) {
    const value = search[name];
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

function kindOf(raw: string | undefined): TermKind {
  for (const kind of TERM_KINDS) {
    if (kind === raw) return kind;
  }
  return "people";
}

function facetFrom(search: CatalogSearch): Facet | undefined {
  for (const kind of TERM_KINDS) {
    const raw = search[KINDS[kind].param];
    if (typeof raw !== "string") continue;
    const term = raw.trim();
    if (term !== "") return { kind, term };
  }
  return undefined;
}

export function catalogViewOf(search: CatalogSearch): CatalogView {
  const facet = facetFrom(search);
  const offset = snapOffset(search.offset);
  const q = search.q?.trim() ? search.q : undefined;
  if (facet) return q ? { mode: "term", facet, q, offset } : { mode: "term", facet, offset };
  if (q) return { mode: "text", q, kind: kindOf(search.kind), offset };
  return { mode: "index", kind: kindOf(search.kind) };
}

export function catalogSearchOf(view: CatalogView): CatalogSearch {
  if (view.mode === "index") return view.kind === "people" ? {} : { kind: view.kind };
  const search: CatalogSearch = {};
  if (view.mode === "term") search[KINDS[view.facet.kind].param] = view.facet.term;
  if (view.q) search.q = view.q;
  if (view.mode === "text" && view.kind !== "people") search.kind = view.kind;
  const offset = offsetParam(view.offset);
  if (offset !== undefined) search.offset = offset;
  return search;
}

export function catalogListParams(view: CatalogListView): LibraryParams {
  if (view.mode === "term") {
    return { facet: view.facet, ...(view.q ? { q: view.q } : {}), offset: view.offset };
  }
  return { q: view.q, offset: view.offset };
}

export function catalogEmptyCopy(view: CatalogListView): string {
  if (view.mode === "text") return `No readings match “${view.q}”.`;
  if (!view.q) return `No readings mention “${view.facet.term}”.`;
  return `No readings mention “${view.facet.term}” and match “${view.q}”.`;
}

export interface TermCount {
  term: string;
  count: number;
}

export type CatalogIndex = Record<TermKind, TermCount[]>;

const TermList = z.array(z.looseObject({ term: z.string(), count: z.number() }));

export const CatalogIndexSchema = z.looseObject({
  people: TermList,
  orgs: TermList,
  keywords: TermList,
  hosts: TermList,
} satisfies Record<TermKind, typeof TermList>);

export const catalogIndexQueryKey = ["library", "catalog-index"] as const;

export type CatalogIndexResult = AccountRead<CatalogIndex>;

export function catalogIndexFromResponse(status: number, body: unknown): CatalogIndexResult {
  if (status === 200) {
    const parsed = CatalogIndexSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(status, "terms returned an unexpected body");
    return {
      state: "ready",
      value: {
        people: parsed.data.people,
        orgs: parsed.data.orgs,
        keywords: parsed.data.keywords,
        hosts: parsed.data.hosts,
      },
    };
  }
  if (status === 403) return { state: "forbidden" };
  if (status === 412) return { state: "account-changed", acting_tenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? `terms returned ${status}`);
}

export async function readCatalogIndexFromBackend(
  backend: BackendReads,
  request: Request,
  expectedTenant: string | undefined,
): Promise<CatalogIndexResult> {
  let result;
  try {
    result = await backend.terms({
      ...forwardedFrom(request),
      ...(expectedTenant === undefined ? {} : { expectedTenant }),
    });
  } catch (err) {
    throw new ApiError(0, `backend entrypoint failed: ${String(err)}`);
  }
  return catalogIndexFromResponse(result.status, result.body);
}
