---
name: corpus-sweep
description: Find and clean duplicate readings in the reading-lite corpus — the same resource stored under two different URL spellings (youtu.be/X vs youtube.com/watch?v=X, a reddit comment permalink vs its thread, http vs https, utm-tagged vs clean), which per-URL ownership cannot catch and corpus-drop cannot reconcile. Canonicalizes URLs, groups the copies, keeps the best one, and drops the rest — so it works on ready readings, which corpus-drop refuses. Also drops an operator-asserted pair (--drop/--keep) for readings that share material but are genuinely different resources, which no URL rule can pair. Dry-run by default. Use when the user says a reading is a duplicate, wants duplicates found or deduped, or when corpus-drop refuses an id because it is ready.
---

# corpus-sweep

Reconciles **duplicate readings of the same resource** and drops the redundant
copies completely: the captured content in R2, then the row, which takes the
URL ownership, revisions, relationships and embedding with it.

**Dry-run by default. It only writes with `--execute`.**

## The gap it fills

URL ownership is keyed on the *exact* submitted URL. So `https://youtu.be/X`
and `https://www.youtube.com/watch?v=X` claim two different rows, the unique
constraint never fires, and both readings reach `ready`. Nothing in the write
path can tell they are one video.

`corpus-drop` can't fix that: it matches selectors by exact URL equality, and
it refuses `ready` readings because a ready reading is a live library entry.

Sweep goes where drop won't, because it carries a stronger invariant than
"never touch ready":

1. A drop is only ever proposed **as part of a group that keeps a survivor** —
   the resource never leaves the corpus entirely.
2. Every drop's **embedding and relationships go with it**, in the same
   transaction as the row. The sweep used to probe Vectorize per drop and
   delete the vector first, because a vector outliving its reading was the one
   inconsistency it could create; the cascade makes that unrepresentable. What
   remains is content in R2, deleted before the row, so a failed object delete
   keeps that reading and the sweep stays re-runnable.

## What counts as the same resource

`canonicalizeUrl` collapses URLs onto one identity key:

- **YouTube**: `youtu.be/X`, `youtube.com/watch?v=X`, `m.`/`music.`/`-nocookie`
  hosts, `/shorts/X`, `/embed/X`, `/live/X`, `/v/X` → one watch URL.
- **Scheme/host**: `http` → `https`, `www.` stripped, host lowercased
  (path case is preserved — many sites are case-sensitive).
- **Reddit**: every thread form reduces to its base36 post id —
  `old.`/`new.`/`np.`/`amp.` hosts, `redd.it/X`, the title slug, and a
  `/comment/<id>` permalink. The slug and comment suffix are decoration around
  one thread, and `reddit-import` imports the whole thread (post + top comments)
  whichever form was submitted, so all of them yield the same reading. Non-thread
  Reddit URLs (subreddit, user pages) fall through to the generic rule.
- **Noise params** dropped: any `utm_*` key (a prefix rule — reddit's iOS share
  sheet emits `utm_name`, which an enumerated list missed), plus `share_id`,
  `si`, `feature`, `ref*`, `fbclid`, `gclid`, `t`/`start` (timecodes). Any other
  param is kept — `?page=2` selects real content.
- Remaining params **sorted**, fragment and trailing slash removed.

## Keeper ranking

Best first, per group:

1. `ready` beats non-ready — a non-ready copy has no summary to lose.
2. **Richer summary** wins: `tldr.length + 10 × (keywords + tags)`, a proxy for
   how much source text the summarizer actually had. This is what separates a
   thin worker-made YouTube reading (metadata floor, no transcript) from the
   same video imported with its transcript.
3. **Newer** wins — the newer copy is usually the deliberate re-import that
   prompted the cleanup.

Override per group with `--keep <rd_ID>`. The plan prints the keeper and the
reason for every group, so check it before `--execute`.

## Asserted pairs — same material, different resource

Sometimes two readings carry the same argument but are genuinely different
resources: a video and the tweet making the same case, an article and its
conference talk. No canonicalization rule can pair those, and none should —
`x.com` is not `youtube.com`, and a rule that merged them would silently
mis-group unrelated readings. The assertion has to come from you:

```bash
npm run ops -- corpus sweep --tenant "$TENANT" --drop rd_TWEET --keep rd_VIDEO --execute
```

This builds a normal one-group plan, so it keeps every safety property the
canonical path has — exactly one survivor, and the drop's vector deleted with
it. The keeper must be `ready`: dropping a summarized reading in favour of a
failed or pending one would destroy the surviving content. `--drop` takes
exactly one `--keep` and no positional selectors, so the assertion stays
unambiguous.

Check both summaries before running. Two readings on one subject are often not
subsets of each other — a tweet's reply thread can carry points its linked
video never makes — and the drop is irreversible short of re-importing.

## Usage

```bash
# Report every duplicate group in the corpus (read-only).
npm run ops -- corpus sweep --tenant "$TENANT"

# Plan one known duplicate — by reading id, or by any URL spelling of it.
npm run ops -- corpus sweep --tenant "$TENANT" rd_PQ132K3HK5
npm run ops -- corpus sweep --tenant "$TENANT" https://youtu.be/0oXOOlqVu5M

# Apply.
npm run ops -- corpus sweep --tenant "$TENANT" rd_PQ132K3HK5 --execute

# Keep the copy the ranking would not have picked.
npm run ops -- corpus sweep --tenant "$TENANT" rd_A --keep rd_B --execute
```

`--tenant` is required on every corpus command. Production uses `--tenant "$TENANT"` from `GET /api/whoami` (see `docs/operations.md`). `--tenant global` is **refused**: it addressed the pre-tenant R2 key root, which has no PostgreSQL representation.

Flags: `--drop <rd_ID>` (asserted-pair mode), `--keep <rd_ID>` (repeatable),
`--database-url-env` (default `DATABASE_URL`), `--bucket` (captured content;
default `READING_LITE_BUCKET` env, then `reading-lite`), `--local` (local
miniflare bucket, and a local database), `--execute`, `--help`.

`--vectorize` is gone: there is no second store to keep in step.

Errors, rather than guessing, when a selector names something that is not part
of any duplicate group, or when `--keep` names two ids in the same group.

## After a sweep: stale relationship claims

A sweep changes the corpus around each keeper, and both `novelty_verdict` and
the similarity snapshot are claims about a *relationship* frozen on one node at
summarize time. Nothing recomputes them, so they can be wrong the moment the
sweep finishes.

This is not hypothetical: two keepers of an earlier sweep were left marked
`duplicate`, each citing as justification the copy that had just been deleted.

So an executed sweep now reports which keepers actually reference a dropped
reading — a cited connection, or a snapshot measured while the dropped copy was
still indexed. It flags only those, not every keeper, so the warning stays worth
reading.

To refresh the measured score (no LLM call, no re-summarization, no tag churn):

```bash
npm run ops -- corpus refresh-neighbours --tenant "$TENANT" rd_KEEPER --sole-writer --execute
```

The `novelty_verdict` label itself only refreshes on a **reprocess**, which
re-runs the summarizer and re-rolls the title and tags on unchanged source text.
Weigh that before reprocessing purely to fix a label — and prefer the score,
which is the more granular signal anyway.

## Prerequisites

A direct PostgreSQL connection string, and a Cloudflare session that can read
**and write** R2 (`wrangler login`, or `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID`).

```sh
set -a; . ~/.config/reading-lite/neon.env; set +a
```

Then pass `--database-url-env NEON_MAIN_DATABASE_URL` (the default is
`DATABASE_URL`).

## Always dry-run first

The default run prints every group, the keeper and why it won, and every object
and row it would delete — and changes nothing. Confirm the keeper choices,
then re-run with `--execute`.

## Implementation
- CLI: `scripts/ops-lib/commands/corpus-sweep.ts` (via `scripts/ops.ts`)
- Pure planner (tested): `scripts/corpus-lib/sweep.ts`
- Corpus reads and row deletes: `scripts/pg-lib/operator-corpus.ts`
- R2 object delete: `scripts/corpus-lib/wrangler-r2.ts`
- Tests: `test/unit/corpus/sweep.test.ts` (node project)

## Related
- **`corpus-drop`** — drop a specific URL or id you already know is junk. Use it
  for dead links and failed cruft; use sweep when the problem is *two copies of
  one thing*, or when drop refuses an id for being ready.
- **`corpus-audit`** — inventory of everything not `ready`.
- **`reddit-import` / `youtube-import`** — recover a fetch-blocked reading
  instead of dropping it. These import under the *clean* URL, which typically
  creates a new ready copy alongside the old failed one — exactly the duplicate
  group sweep then collapses.
- **`corpus-recover`** — *fix* recoverable readings instead of dropping them.
