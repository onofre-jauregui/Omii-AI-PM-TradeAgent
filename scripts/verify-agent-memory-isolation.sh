#!/usr/bin/env bash
# Runs supabase/tests/agent_memory_isolation.sql against a project and asserts the
# pass marker. Writes nothing — the SQL rolls itself back.
#
#   ./scripts/verify-agent-memory-isolation.sh [project_ref]
#
# Requires SUPABASE_ACCESS_TOKEN_KTA (see CLAUDE.md — never the global token).
set -euo pipefail

REF="${1:-uyfnezxmgwitpzsrnkst}"
SQL_FILE="$(dirname "$0")/../supabase/tests/agent_memory_isolation.sql"
MARKER="AGENT_MEMORY_ISOLATION_PASS"

: "${SUPABASE_ACCESS_TOKEN_KTA:?set SUPABASE_ACCESS_TOKEN_KTA (source ~/.omii_env)}"
[ -f "$SQL_FILE" ] || { echo "missing $SQL_FILE" >&2; exit 1; }

PAYLOAD="$(mktemp)"
trap 'rm -f "$PAYLOAD"' EXIT
python3 -c "import json,sys; print(json.dumps({'query': open(sys.argv[1]).read()}))" "$SQL_FILE" > "$PAYLOAD"

RESPONSE="$(curl -sS -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN_KTA" \
  -H "Content-Type: application/json" \
  --data-binary @"$PAYLOAD")"

# The script signals success by raising the marker, so a *successful* run comes
# back as an error payload containing it. Silence is not success: a DO block that
# returns [] exited without reaching the final assertion.
if grep -q "$MARKER" <<<"$RESPONSE"; then
  echo "PASS — $(grep -o "$MARKER[^\\\\\"]*" <<<"$RESPONSE" | head -1)"
  exit 0
fi

echo "FAIL — agent_memory isolation check did not reach the pass marker" >&2
echo "$RESPONSE" >&2
exit 1
