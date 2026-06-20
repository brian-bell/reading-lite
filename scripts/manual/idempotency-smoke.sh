#!/usr/bin/env bash
#
# Manual smoke for the idempotent-URL-submits PR (issue #33).
# Companion to plans/007-manual-test-idempotent-submits.md.
#
# Exercises the submit / import / lookup / reprocess idempotency matrix against a
# running Worker. Each request prints its HTTP status + JSON body so you can eyeball
# the expected status from the checklist.
#
# Requires: bash, curl, and jq (for pretty output + poll parsing).
#
# Usage:
#   READER_API_TOKEN=... ./scripts/manual/idempotency-smoke.sh <group> [url]
#
#   BASE   env var  base URL (default http://127.0.0.1:8787; prod: https://reading-lite.bbell.dev)
#   TOKEN  resolved from READER_API_TOKEN env, else --token, else .dev.vars
#
# Groups:
#   a    Submit idempotency matrix (A1-A5) — needs queue (deployed)
#   b    Markdown-import idempotency (B1-B5) — needs queue (deployed)
#   c    Lookup read-only (C1-C5)
#   d    Reprocess (D1, D3, D4) — needs queue (deployed); pass an existing id as [url]
#   f1   No-queue 503 guard (local wrangler dev)
#   one  Single submit + poll of [url]
#
# Examples:
#   ./scripts/manual/idempotency-smoke.sh f1
#   BASE=https://reading-lite.bbell.dev ./scripts/manual/idempotency-smoke.sh a "https://example.com/throwaway-$RANDOM"
#   BASE=https://reading-lite.bbell.dev ./scripts/manual/idempotency-smoke.sh c "https://example.com/known-url"
#
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8787}"

# --- token resolution: READER_API_TOKEN env > --token > .dev.vars -------------
TOKEN="${READER_API_TOKEN:-}"
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
set -- "${ARGS[@]:-}"
if [ -z "$TOKEN" ] && [ -f .dev.vars ]; then
  TOKEN="$(grep -E '^READER_API_TOKEN=' .dev.vars | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
fi
if [ -z "$TOKEN" ]; then
  echo "No token. Set READER_API_TOKEN, pass --token, or add it to .dev.vars" >&2
  exit 1
fi

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

GROUP="${1:-}"
URL="${2:-https://example.com/reading-lite-smoke-$$}"

AUTH=(-H "Authorization: Bearer ${TOKEN}")

# req METHOD PATH [json-body] — prints "HTTP <code>" then pretty body. Echoes the id.
req() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -w $'\n%{http_code}' -X "$method" "${AUTH[@]}" "${BASE}${path}")
  if [ -n "$body" ]; then args+=(-H 'Content-Type: application/json' -d "$body"); fi
  local out code json
  out="$(curl "${args[@]}")"
  code="$(printf '%s' "$out" | tail -n1)"
  json="$(printf '%s' "$out" | sed '$d')"
  echo "  HTTP ${code}  ${method} ${path}"
  printf '%s\n' "$json" | jq . 2>/dev/null | sed 's/^/    /' || printf '    %s\n' "$json"
  printf '%s' "$json" | jq -r '.id // empty' 2>/dev/null || true
}

poll() {
  local id="$1" i status
  for i in $(seq 1 30); do
    status="$(curl -sS "${AUTH[@]}" "${BASE}/readings/${id}" | jq -r '.status // "?"')"
    echo "    poll ${i}: status=${status}"
    case "$status" in ready|failed) return 0 ;; esac
    sleep 2
  done
}

submit()  { req POST "/readings" "{\"url\":\"$1\"${2:+,\"email\":$2}}"; }
import()  { req POST "/readings/import-markdown" "$1"; }
lookup()  { req GET  "/readings/lookup?url=$(jq -rn --arg u "$1" '$u|@uri')"; }
reproc()  { req POST "/readings/${1}/reprocess" "${2:-}"; }

hdr() { echo; echo "=== $* ==="; }

case "$GROUP" in
  a)
    echo "URL: $URL"
    hdr "A1 new submit -> expect 202 pending"
    ID="$(submit "$URL" | tail -n1)"
    echo "  id=$ID"; poll "$ID"
    hdr "A2 re-submit ready -> expect 200 same id ($ID)"
    submit "$URL" >/dev/null; submit "$URL"
    hdr "A5 email flags accepted"
    submit "$URL" true >/dev/null; submit "$URL" false >/dev/null; echo "  (both accepted)"
    hdr "lookup stable -> expect 200 {id:$ID}"
    lookup "$URL"
    echo; echo "A3 (pending) and A4 (failed) need timing/a failing URL — see checklist."
    ;;
  b)
    echo "source_url: $URL"
    BODY="$(jq -nc --arg u "$URL" '{source_url:$u, markdown:"# Smoke\n\nHello from idempotency smoke.", title:"Smoke"}')"
    hdr "B1 new import -> expect 202 pending"
    ID="$(import "$BODY" | tail -n1)"; echo "  id=$ID"; poll "$ID"
    hdr "B2 re-import ready -> expect 200 same id ($ID)"
    import "$BODY"
    ;;
  c)
    echo "URL: $URL"
    hdr "lookup -> 200 {id} if owned (ready/pending/failed), 409 if initializing, 404 if unknown"
    lookup "$URL"
    ;;
  d)
    [ -n "${2:-}" ] || { echo "pass an existing reading id as arg 2" >&2; exit 1; }
    ID="$2"
    hdr "D3 reprocess running, no force -> expect 409 OR 202 if idle"
    reproc "$ID"
    hdr "D4 reprocess force -> expect 202"
    reproc "$ID" '{"force":true}'
    ;;
  f1)
    echo "Run against local 'wrangler dev' (no READING_JOBS binding)."
    hdr "F1 submit -> expect 503 queue not configured"
    submit "$URL"
    hdr "F1 import -> expect 503 queue not configured"
    import "$(jq -nc --arg u "$URL" '{source_url:$u, markdown:"x"}')"
    ;;
  one)
    ID="$(submit "$URL" | tail -n1)"; echo "  id=$ID"; poll "$ID"
    ;;
  *)
    echo "Usage: $0 {a|b|c|d|f1|one} [url|id]" >&2
    echo "See plans/007-manual-test-idempotent-submits.md" >&2
    exit 1
    ;;
esac
