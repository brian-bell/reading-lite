# Plan 003 — Remove retired Backlite migration code

## Goal

The Backlite migration source is retired. Remove the one-shot migration script,
its library, its tests, and its docs. Because the migration's `MIGRATE_*` env
vars and `.migrate.vars` file are **shared** with the still-active
`corpus-recover --batch` bulk path, rename that surviving config from `MIGRATE_*`
→ `CORPUS_*` and `.migrate.vars` → `.corpus.vars` so no "migration" naming
lingers in the live path.

Decision (confirmed): rename to `CORPUS_*` (not keep-as-is).

## Scope at a glance

**Delete (pure migration, no live consumers):**

- `scripts/migrate.ts` (208 lines) — CLI entry
- `scripts/migrate-lib/` — `clients.ts` (re-export shim), `normalize.ts`,
  `plan.ts`, `run.ts`
- `test/unit/migrate/normalize.test.ts`, `plan.test.ts`, `run.test.ts`
- `.migrate.vars.example`

**Preserve, do not delete:**

- `scripts/lib/cf-clients.ts` — shared by `corpus-recover` + the batch path.
  `migrate-lib/clients.ts` only re-exports from here; deleting the shim is safe.
- `scripts/lib/dotvars.ts` — shared by 9 scripts.
- `test/unit/migrate/dotvars.test.ts` — **the only coverage for `loadDotVars`**.
  It is misfiled under `migrate/`. **Move** it to `test/unit/lib/dotvars.test.ts`
  (fix the relative import depth), do not delete it.

**Rename (`MIGRATE_*` → `CORPUS_*`, `.migrate.vars` → `.corpus.vars`):**

- `scripts/corpus-lib/config.ts` — reads the 7 shared vars + the dot file.
- `test/unit/corpus/batch/config.test.ts` — asserts those var names.
- `scripts/corpus-recover.ts` — two comments reference them.
- `.gitignore` — `.migrate.vars` entry.
- New `.corpus.vars.example` replacing `.migrate.vars.example`.

**Config wiring:**

- `package.json` — remove `"migrate": "tsx scripts/migrate.ts"` script.
- `vitest.workspace.ts` — remove `"test/unit/migrate/**/*.test.ts"` from the
  node-pool glob; add `"test/unit/lib/**/*.test.ts"` if not already covered
  (verify the moved dotvars test still lands in the node pool, since it uses
  `node:fs`/`os`/`path`).

**Docs:**

- `README.md` — delete the "Migration from Backlite" section (≈ lines 186–219);
  fix the repo-layout block (lines 308, 311, 318, 333) and the line-126 "cold
  cache after migration" aside; update the `.migrate.vars`/`MIGRATE_*` mention at
  line 203 (now part of the corpus path docs, renamed).
- `CLAUDE.md` — line 21 (`the same pattern as migrate.ts`), line 27 (`e.g.
  test/unit/migrate/` example → use a surviving node-pool dir), line 31 (drop the
  "Migration script not run end-to-end" entry under "Not yet done").
- `wrangler.toml` — line ~60 comment ("so migrated rows are visible") reworded to
  drop migration framing (it documents `remote = true` for the dev server).
- `plans/002-batch-bulk-path.md` — historical; leave as-is (it records the design
  at the time). Optionally add a one-line note that the vars were later renamed.

> The `.claude/worktrees/extractor-bug-issue-18/` copy is a separate detached
> worktree — out of scope; do not touch it.

## Var name mapping

Only these 7 are consumed by the surviving corpus path (rename all):

| Old | New |
|---|---|
| `MIGRATE_R2_ACCOUNT_ID` | `CORPUS_R2_ACCOUNT_ID` |
| `MIGRATE_R2_ACCESS_KEY` | `CORPUS_R2_ACCESS_KEY` |
| `MIGRATE_R2_SECRET_KEY` | `CORPUS_R2_SECRET_KEY` |
| `MIGRATE_R2_BUCKET` | `CORPUS_R2_BUCKET` |
| `MIGRATE_CF_API_TOKEN` | `CORPUS_CF_API_TOKEN` |
| `MIGRATE_VECTORIZE_ACCOUNT_ID` | `CORPUS_VECTORIZE_ACCOUNT_ID` |
| `MIGRATE_VECTORIZE_INDEX` | `CORPUS_VECTORIZE_INDEX` |

`MIGRATE_SQLITE` and `MIGRATE_CONTENT_DIR` are migration-only — drop entirely
(no `CORPUS_*` equivalent).

## Approach (TDD where it bites; deletion otherwise)

This is mostly deletion, but two pieces are behavior-bearing and get the
red→green treatment.

### Step 1 — Lock surviving coverage before deleting (red/green)

1. Move `test/unit/migrate/dotvars.test.ts` → `test/unit/lib/dotvars.test.ts`,
   fixing the import (`../../../scripts/lib/dotvars` → `../../../scripts/lib/dotvars`
   stays the same depth — confirm: `test/unit/lib/` is the same depth as
   `test/unit/migrate/`, so the path is unchanged). Run it; it must stay green.
   This guarantees `loadDotVars` coverage survives the directory deletion.
2. Update `test/unit/corpus/batch/config.test.ts` to use `CORPUS_*` keys and
   `.corpus.vars` wording (the `toThrow(/CORPUS_R2_ACCOUNT_ID/)` assertion, the
   staging-bucket case, the destructured `CORPUS_VECTORIZE_INDEX`). Run → **red**
   (config.ts still reads `MIGRATE_*`).

### Step 2 — Rename the shared config (green)

3. In `scripts/corpus-lib/config.ts`: rename all 7 `MIGRATE_*` reads → `CORPUS_*`,
   `loadDotVars(".migrate.vars")` → `loadDotVars(".corpus.vars")`, and the error
   string + comment. Run the config test → **green**.
4. Update the two comments in `scripts/corpus-recover.ts`.
5. `.gitignore`: `.migrate.vars` → `.corpus.vars`.
6. Replace `.migrate.vars.example` with `.corpus.vars.example` containing only
   the 7 `CORPUS_*` keys (drop `*_SQLITE`/`*_CONTENT_DIR`), and reword the header
   comment to describe only the corpus batch path (no migration mention).

### Step 3 — Delete migration code

7. `git rm scripts/migrate.ts scripts/migrate-lib/{clients,normalize,plan,run}.ts`
8. `git rm test/unit/migrate/{normalize,plan,run}.test.ts` (dotvars already moved
   out in Step 1). The `test/unit/migrate/` dir should now be empty/removed.
9. `package.json`: remove the `migrate` script.
10. `vitest.workspace.ts`: drop the `test/unit/migrate/**` glob; ensure the node
    pool still globs the moved dotvars test (add `test/unit/lib/**` if needed).

### Step 4 — Docs + config comments

11. README: remove the "Migration from Backlite" section; fix repo-layout lines
    (drop `migrate.ts + migrate-lib/...`), the node-pool test note, the
    line-126 aside, and reframe the `.corpus.vars`/`CORPUS_*` resolution note
    under the corpus batch path.
12. CLAUDE.md: reword line 21 (drop "the same pattern as `migrate.ts`" → "the
    same S3/REST client module"), line 27 example dir, and remove the line-31
    "Migration script not run end-to-end" bullet.
13. wrangler.toml: reword the `remote = true` comment to drop "migrated rows".

### Step 5 — Verify

14. `grep -rin "migrat" --include="*.ts" --include="*.toml" --include="*.json" \
    --include="*.md" . | grep -v node_modules | grep -v .claude/worktrees` —
    expect only intentional historical mentions in `plans/00*.md`.
15. `npm run typecheck` (or `tsc --noEmit`) — catches any dangling import of
    `migrate-lib` / the deleted clients shim.
16. `npm test` — full suite green (node pool picks up moved dotvars test; corpus
    config test green on `CORPUS_*`).
17. `npm run lint` if present.

## Operational follow-up (outside the diff — call out in PR description)

Renaming the live vars is a breaking config change for anyone running
`corpus-recover --batch`:

- **Local:** `mv .migrate.vars .corpus.vars` and rename the keys inside
  (`MIGRATE_*` → `CORPUS_*`); drop the two `*_SQLITE`/`*_CONTENT_DIR` lines.
- **Deployed/CI:** if any `MIGRATE_*` values live in CI secrets or a shell
  profile used for batch runs, rename them to `CORPUS_*`.

> Optional safety net (not in this plan unless requested): a transitional
> fallback in `config.ts` (`vars.CORPUS_R2_ACCOUNT_ID ?? vars.MIGRATE_R2_ACCOUNT_ID`)
> to avoid a hard cutover. Skipped by default since the user chose a clean rename.

## Risks / notes

- **Lost test coverage** is the main trap: `dotvars.test.ts` must be *moved*, not
  swept up in the `test/unit/migrate/` deletion. Step 1 does it first, on purpose.
- **`cf-clients.ts` must stay** — it looks migration-adjacent (named in the
  migrate imports) but is the live batch path's client. Only the `migrate-lib`
  re-export shim goes.
- **Vitest node vs workers pool**: the moved dotvars test imports `node:fs` etc.,
  so it must remain in the node project glob, not the workers/Miniflare one
  (per CLAUDE.md's load-bearing pool split).
- Branch off latest `main`; do not commit to `main` (per repo conventions). One
  PR; commit per logical step (preserve-coverage / rename-config / delete-code /
  docs) reads cleanly.
