# Archive export format

`format_version` 1. This is the package a reader downloads from
`GET /api/exports/:id/download`, and the contract a later restore or import
should read. The request, queue, and download behavior live with the export
routes; this document is only the zip.

The decision is [ADR 0004](decisions/0004-tenant-provider-credentials.md)
("Archive export"). Version 1 is one ZIP32 archive. There is no ZIP64: an
export that would pass 65535 entries or 4 GiB fails instead of writing a file
`unzip` cannot read. The in-zip `README.md` says the same things a person
needs with the file open and the repo closed.

## Layout

| Path | What it is |
| --- | --- |
| `README.md` | This format, in short, including `format_version`. |
| `export.json` | `format_version`, `generated_at` (UTC), and reading counts by status: `readings`, `pending`, `ready`, `failed`. Every status is counted. |
| `index.json` | `{ "version": 1, "items": [...] }`, one item per exported reading, in library order. The item is the list-row shape, so it includes `key_prefix`. That prefix is the row's historical storage location. It is not a path inside this zip. |
| `readings/<id>/manifest.json` | The reading record: summary, metadata, content facts, and relationships. Same fields as the reading detail. No `key_prefix`. |
| `readings/<id>/extracted.md` | Captured Markdown. Present when `content_status` is `captured` and the object was in storage. |
| `readings/<id>/raw.<ext>` | The original bytes. `<ext>` comes from the stored content type, not from the storage key: `html` (`text/html`, `application/xhtml+xml`), `md` (`text/markdown`), `pdf`, `json`, `txt` (any other `text/*`), or `bin`. |
| `report.json` | Gaps. The arrays are always present. An empty array means that check found nothing. |
| `checksums.sha256` | SHA-256 of every other file. |

Content bytes are read through the reading's stored keys (`contentKeys`). The
archive never rebuilds an object path from `key_prefix`. A published reading's
bytes live under its revision; an imported reading's bytes live at the legacy
spelling; a reading that never published serves its latest attempt's bytes.
All arrive here as `readings/<id>/extracted.md` and `readings/<id>/raw.<ext>`.

Each reading's manifest and keys are read in one database snapshot, so the
manifest and the bytes beside it describe the same revision. A reprocess that
publishes after that read deletes the content it replaced. The export then
finds the object missing, reads the reading again, and packs the newer
revision whole.

`extracted.md` is omitted when `content_status` is `raw_only` or `failed`.
Those readings were not extracted. `raw.<ext>` is expected for every reading.
A missing expected object is a `report.json` gap, not a skipped file.

## report.json

```json
{
  "format_version": 1,
  "missing_artifacts": [
    { "reading_id": "rd_example", "kind": "extracted", "path": "readings/rd_example/extracted.md" }
  ],
  "dangling_relationships": [
    { "reading_id": "rd_example", "kind": "connection", "target_id": "rd_missing" }
  ],
  "warnings": [
    {
      "reading_id": "rd_example",
      "code": "content_hash_mismatch",
      "path": "readings/rd_example/raw.html",
      "expected": "<content_sha256 from the row>",
      "actual": "<sha256 of the file in this zip>"
    }
  ]
}
```

`missing_artifacts[].kind` is `raw` or `extracted`. `path` is the archive path
the file would have had.

`dangling_relationships` lists connections and tensions whose target is not a
reading in this export. A target that is in `index.json` is not dangling.
Neighbourhood id lists and tension-judgement memory are not relationships.

`warnings[].code`:

| Code | Comparison |
| --- | --- |
| `content_size_mismatch` | `raw.<ext>` byte length against `content_bytes` |
| `content_hash_mismatch` | SHA-256 of `raw.<ext>` against `content_sha256` |
| `extracted_size_mismatch` | `extracted.md` byte length against `extracted_bytes`, when the row has that field |

The raw comparisons are skipped while the row still carries the empty-content
placeholder (`content_bytes` 0, `content_sha256` all zeros): a pending
submission, or a failure before the reading published, has no content facts
to compare, although an attempt may already have stored bytes. Those bytes
still ship.

The file in the zip is the object that was stored. The warning says the row
disagrees with those bytes. That disagreement is expected for a few production
readings — a failed reprocess restored the manifest and not the overwritten
content — and is recorded in
[the cutover notes](postgres-cutover.md#known-discrepancies). It does not fail
the export, and it is not dropped.

Rows are sorted by `reading_id`, then by `kind` or `code`, then by `path` or
`target_id`.

## checksums.sha256

GNU `sha256sum` text mode: one line per other file, `HHHH…  path`, 64
lowercase hex digits, two spaces, the archive-relative path, sorted by path,
with a trailing newline. The hash is of the file bytes, not of the compressed
zip entry. `checksums.sha256` is not listed in itself.

## Excluded

The package does not contain:

- attempt events, attempt logs, or processing checkpoints
- embeddings or other vectors
- internal object keys (`raw_key`, `extracted_key`, revision paths); manifests do not carry `key_prefix`
- provider credentials, sessions, tokens, spend records, or quota records

`index.json` still carries `key_prefix` because that is the list-row shape.
Do not use it to find bytes. The bytes are at `readings/<id>/`.

## Restore

Import is not implemented. A later importer should:

1. Reject a zip whose `export.json` `format_version` is not `1`, and verify `checksums.sha256` before trusting any other file.
2. Create one reading per `index.json` item from `readings/<id>/manifest.json`. Counts in `export.json` should match the index.
3. Keep a relationship when its target is also imported. `report.json` names every target that was already dangling at export time.
4. Store `raw.<ext>` and `extracted.md` through the current content-key helpers, writing the zip bytes as the reading's content. Ignore `key_prefix` as a storage path.
5. Keep the zip bytes when a warning names that file. The row's `content_bytes`, `content_sha256`, or `extracted_bytes` is the side that disagreed.
6. Treat a missing artifact as content the export could not copy. Do not invent an empty object for it.
7. Recompute embeddings by reprocessing. This package does not carry vectors, attempt logs, or account secrets, and an import must not expect them.
