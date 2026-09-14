#!/usr/bin/env bash
# Route-precedence smoke check for a host the frontend Worker serves (ADR 0003).
# Run after every deploy or route change:
#
#   app/scripts/smoke-host.sh https://next-staging.readinglite.ai
#
# Passes only when the backend answers /health and a signed-out /api/whoami, and
# the frontend (not Pages) answers /: its rendered HTML is private, no-store.
# Needs no session and reads no reading data.
set -euo pipefail

base="${1:?usage: smoke-host.sh https://host}"
base="${base%/}"
failures=0

check() {
  local label="$1" ok="$2" detail="$3"
  if [[ "$ok" == 1 ]]; then echo "ok   $label"; else echo "FAIL $label: $detail"; failures=$((failures + 1)); fi
}

health="$(curl -sS --max-time 15 "$base/health" || true)"
check "/health answers ok from the backend" "$([[ "$health" == "ok" ]] && echo 1 || echo 0)" "got '${health:0:80}'"

whoami="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code} %{content_type}' "$base/api/whoami" || true)"
check "/api/whoami is a backend 401 JSON while signed out" \
  "$([[ "$whoami" == 401\ application/json* ]] && echo 1 || echo 0)" "got '$whoami'"

headers="$(curl -sS --max-time 15 -D - -o /dev/null "$base/" | tr -d '\r' || true)"
status="$(awk 'NR==1 {print $2}' <<<"$headers")"
cache="$(awk -F': ' 'tolower($1)=="cache-control" {print tolower($2)}' <<<"$headers")"
check "/ renders from the frontend Worker" \
  "$([[ "$status" == 200 && "$cache" == *private* && "$cache" == *no-store* ]] && echo 1 || echo 0)" \
  "status '$status', cache-control '$cache'"

if ((failures > 0)); then
  echo "$failures check(s) failed for $base"
  exit 1
fi
echo "all checks passed for $base"
