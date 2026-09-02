// Tier-1 (`ops corpus refresh-neighbours`) storage, over direct credentials
// instead of a wrangler child process.
//
// The wrangler adapter spends ~0.8s of Node start-up on every Vectorize query
// and every manifest read — measured at 1.07s/spawn against production, and
// 0.92s vs 73ms for the same R2 object over the S3 API. A tier-1 pass is two
// spawns per ready reading, so on a 553-reading corpus roughly 85-90% of the
// 16-20 minute run is process start-up rather than I/O.
//
// This module keeps the wrangler path intact as a fallback and adds a
// credential-backed one with the same observable behaviour: the same requests
// wrangler itself makes (a single POST to Vectorize v2 /query carrying
// `vectorId`, a single R2 GET per manifest), the same match parsing, and the
// same three-way not-found/present/error classification. A pass over either
// adapter must produce a byte-identical refresh-report.json.

import type { R2InventoryClient, VectorizeAdminClient } from "../lib/cf-clients";
import type { R2Deps } from "../corpus-lib/wrangler-r2";
import { parseVectorQueryMatch } from "../corpus-lib/wrangler-r2";
import type { RefreshNeighbour, RefreshRow } from "../corpus-lib/refresh-neighbours";
import type { CorpusRefreshNeighboursR2 } from "./commands/corpus-refresh-neighbours";
import { casMergeListIndex, type ListIndexCasDeps } from "./list-index-cas";
import { r2KeyLayout } from "../../src/modules/stores/layout";

// Relative-key spelling only, like wrangler-r2: R2Deps.keyRoot is applied at
// the single point where a key becomes a bucket path.
const layout = r2KeyLayout();

export type NeighboursBackend = "direct" | "wrangler";

export interface BackendChoice {
  backend: NeighboursBackend;
  /** Why this backend was chosen, for the command header. */
  reason: string;
  /**
   * The Cloudflare account the direct path will address, when the credentials
   * name one. Printed in the header: a bucket name alone does not say which
   * account's bucket, and staging and production spell some of them the same.
   * Absent on the wrangler path, which resolves its own account.
   */
  accountId?: string;
  /**
   * The account the Vectorize half will address, when `CORPUS_VECTORIZE_*`
   * points somewhere else. Present only when the two differ, because that is
   * the case the header would otherwise misreport.
   */
  vectorizeAccountId?: string;
}

/** The narrow slice of the Vectorize client tier 1 needs. */
export type NeighbourVectorizeClient = Pick<VectorizeAdminClient, "queryById">;

export interface BackendInputs {
  /** `--via wrangler` / `--via direct`, when the operator forced one. */
  via?: NeighboursBackend;
  /** `--local`: the miniflare bucket only wrangler can reach. */
  local: boolean;
  vars: Record<string, string | undefined>;
}

// Direct tier 1 needs BOTH halves: an R2 credential for the manifest reads and
// a Cloudflare API token for Vectorize, which has no S3-style access-key path.
// An account with S3 keys but no token can still read manifests directly and
// still cannot query the index, so it is not a usable direct backend.
function directCredential(vars: Record<string, string | undefined>): string | undefined {
  const accountId = first(vars, ["CORPUS_R2_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID"]);
  const apiToken = first(vars, ["CORPUS_CF_API_TOKEN", "CLOUDFLARE_API_TOKEN"]);
  if (!accountId || !apiToken) return undefined;
  if (vars.CORPUS_R2_ACCESS_KEY && vars.CORPUS_R2_SECRET_KEY) return "CORPUS_R2_* keys";
  return "CLOUDFLARE_API_TOKEN";
}

function first(
  vars: Record<string, string | undefined>,
  names: string[],
): string | undefined {
  for (const name of names) {
    const value = vars[name];
    if (value) return value;
  }
  return undefined;
}

/**
 * Which tier-1 storage path to run over. Direct whenever credentials allow it,
 * because that is the whole point of the slice; wrangler when the operator asks
 * for it, when the target is the local miniflare bucket (which no direct client
 * can reach), or when no usable credential is present — the pre-existing
 * behaviour, so an operator with only `wrangler login` keeps working.
 */
export function chooseNeighboursBackend(inputs: BackendInputs): BackendChoice {
  if (inputs.via === "wrangler") return { backend: "wrangler", reason: "--via wrangler" };
  if (inputs.local) {
    // --via direct --local is rejected as usage before this point; reaching
    // here means --local alone, which only wrangler can serve.
    return { backend: "wrangler", reason: "--local" };
  }
  const accountId = first(inputs.vars, ["CORPUS_R2_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID"]);
  // The same precedence the Vectorize client is built with. Usually the same
  // account; when it is not, the header has to say so, or it names the account
  // holding the manifests while the queries go somewhere else entirely.
  const vectorizeAccountId = first(inputs.vars, [
    "CORPUS_VECTORIZE_ACCOUNT_ID",
    "CORPUS_R2_ACCOUNT_ID",
    "CLOUDFLARE_ACCOUNT_ID",
  ]);
  const account = {
    ...(accountId === undefined ? {} : { accountId }),
    ...(vectorizeAccountId === undefined || vectorizeAccountId === accountId
      ? {}
      : { vectorizeAccountId }),
  };
  if (inputs.via === "direct") return { backend: "direct", reason: "--via direct", ...account };
  const credential = directCredential(inputs.vars);
  if (credential) return { backend: "direct", reason: credential, ...account };
  return {
    backend: "wrangler",
    reason: "no CORPUS_R2_*/CLOUDFLARE_API_TOKEN credentials",
  };
}

/** Header lines naming the path a pass actually ran over, and where. */
export function describeBackend(choice: BackendChoice): string[] {
  const label = choice.backend === "direct" ? "direct (S3/REST)" : "wrangler";
  const lines = [`Storage: ${label} — ${choice.reason}`];
  if (choice.backend === "direct" && choice.accountId !== undefined) {
    lines.push(
      choice.vectorizeAccountId === undefined
        ? `Account: ${choice.accountId}`
        : `Account: ${choice.accountId} (R2), ${choice.vectorizeAccountId} (Vectorize)`,
    );
  }
  return lines;
}

export interface DirectNeighboursDeps {
  /** One R2 client per bucket; built lazily so plan/help resolve no credentials. */
  r2: (bucket: string) => R2InventoryClient;
  /** One Vectorize client per (index, namespace). */
  vectorize: (index: string, namespace: string | undefined) => NeighbourVectorizeClient;
  /**
   * CAS knobs for the closing index/list.json flush. Tests drive contention
   * without waiting; a real run takes the defaults.
   */
  listCas?: ListIndexCasDeps;
}

export function directNeighboursR2(deps: DirectNeighboursDeps): CorpusRefreshNeighboursR2 {
  const clients = new Map<string, R2InventoryClient>();
  const client = (r2Deps: R2Deps): R2InventoryClient => {
    const existing = clients.get(r2Deps.bucket);
    if (existing) return existing;
    const made = deps.r2(r2Deps.bucket);
    clients.set(r2Deps.bucket, made);
    return made;
  };

  const indexes = new Map<string, NeighbourVectorizeClient>();
  const index = (name: string, namespace: string | undefined): NeighbourVectorizeClient => {
    // A NUL cannot appear in an index name or a namespace, so the composite
    // cache key is unambiguous.
    const cacheKey = `${name}\u0000${namespace ?? ""}`;
    const existing = indexes.get(cacheKey);
    if (existing) return existing;
    const made = deps.vectorize(name, namespace);
    indexes.set(cacheKey, made);
    return made;
  };

  // The single point where a relative key becomes a tenant-rooted bucket key.
  const rooted = (key: string, r2Deps: R2Deps): string => `${r2Deps.keyRoot}${key}`;

  return {
    async readListIndex(r2Deps) {
      const key = rooted(layout.listIndexKey(), r2Deps);
      // The client throws on a read error and answers null only for a 404, so
      // a transient failure cannot be mistaken for an empty corpus — the same
      // reason wrangler-r2 reads this one strictly. Read with the ETag: it
      // costs nothing over a plain GET and it is what lets the next incremental
      // run recognise a byte-identical index.
      const object = await client(r2Deps).getWithEtag(key);
      if (object === null) {
        throw new Error(`could not read ${layout.listIndexKey()} from bucket ${r2Deps.bucket}`);
      }
      const parsed: unknown = JSON.parse(object.body);
      const items = (parsed as { items?: unknown }).items;
      if (!Array.isArray(items)) throw new Error(`${layout.listIndexKey()} has no items array`);
      return { items: items as RefreshRow[], ...(object.etag === "" ? {} : { etag: object.etag }) };
    },

    // The run marker. A 404 is the only absence — the first incremental run on
    // a corpus, or one whose marker was deleted — and every other failure
    // throws, because "unreadable" must not read as "never ran".
    async readRefreshState(r2Deps) {
      const raw = await client(r2Deps).get(rooted(layout.refreshStateKey(), r2Deps));
      return raw === null ? null : JSON.parse(raw);
    },

    async writeRefreshState(state, r2Deps) {
      await client(r2Deps).put(
        rooted(layout.refreshStateKey(), r2Deps),
        JSON.stringify(state),
        { contentType: "application/json" },
      );
    },

    async readManifest(keyPrefix, r2Deps) {
      // Mirrors wrangler-r2's getOutcome classification, surfaced strictly: a
      // confirmed-absent object (404) is null, and any other failure throws
      // rather than collapsing into "no manifest". The command treats both as a
      // failed measurement, so the report is the same either way, but a
      // transient read must not be reportable as a missing manifest.
      const raw = await client(r2Deps).get(rooted(layout.manifestKey(keyPrefix), r2Deps));
      return raw === null ? null : JSON.parse(raw);
    },

    async queryByVectorId(indexName, id, topK, namespace, opts) {
      const matches = await index(indexName, namespace).queryById(id, {
        topK,
        // Metadata is the measurement pass's payload (title/tldr/tags/
        // created_at go straight into the report); a reverse-neighbour scoping
        // query reads only ids and scores, and asks for none.
        returnMetadata: opts?.metadata !== false,
      });
      // A present vector always matches itself, so an empty list is the
      // missing-vector signal and nothing else — the same outcome wrangler
      // reports as "Could not find any relevant vectors" on a zero exit. Every
      // real failure has already thrown out of the client.
      if (matches.length === 0) return null;
      // Ids come back namespace-prefixed ("{tenant}:{readingId}") exactly as
      // wrangler prints them. Stripping belongs to the command, which owns the
      // tenant selector; doing it here would make the two adapters disagree.
      // Routing through wrangler-r2's own parser is what keeps the two
      // adapters' neighbour objects identical: VectorizeMatch is the raw wire
      // object wrangler prints, just typed.
      const parsed = matches.map((match) => parseVectorQueryMatch(match));
      // Same rule as the wrangler adapter: a dropped entry costs the measuring
      // caller one neighbour, but it costs the metadata-less scoping caller its
      // page count, which is how a truncated reverse set is recognised.
      if (opts?.metadata === false && parsed.some((match) => match === null)) {
        throw new Error(`unexpected vectorize match entry for ${id}`);
      }
      return parsed.filter((m): m is RefreshNeighbour => m !== null);
    },

    async putManifest(keyPrefix, body, r2Deps) {
      await client(r2Deps).put(
        rooted(layout.manifestKey(keyPrefix), r2Deps),
        JSON.stringify(body),
        { contentType: "application/json" },
      );
    },

    // The one write in tier 1 that is not scoped to a single reading, and the
    // only place the corpus-wide document is rewritten: an If-Match
    // read-merge-write, so the rows this pass measured get their fresh
    // similarity and every other row keeps whatever the live index has.
    // Whichever client `deps.r2` built has to carry ETags and honour If-Match.
    // Both do: the tier-2/3 manifest CAS already depends on that over the same
    // two clients, S3-keyed and CLOUDFLARE_API_TOKEN-only alike.
    async mergeListRows(patches, r2Deps) {
      await casMergeListIndex(
        client(r2Deps),
        rooted(layout.listIndexKey(), r2Deps),
        patches,
        deps.listCas ?? {},
      );
    },
  };
}
