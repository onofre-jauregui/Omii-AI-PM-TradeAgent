#!/usr/bin/env bash
#
# Replay every migration into a throwaway Postgres and fail loudly on the first
# one that does not apply.
#
# Why this exists: CI used to apply migrations to a hosted "staging" Supabase
# project. That project no longer exists, the STAGING_SUPABASE_PROJECT_REF secret
# resolves to empty, and the job had been passing vacuously — it only issues a
# request when there is a pending migration, so a broken pipeline looked green
# for as long as nobody changed the schema. The first real migration in weeks
# failed it (2026-08-06) and took the staging deploy and the entire .live E2E gate
# down with it, because both `needs:` this job.
#
# An ephemeral database is strictly better here: it costs nothing, cannot drift
# from the migration files, cannot be deleted out from under CI, and replays from
# zero every run — so it catches the exact class of bug a long-lived staging DB
# hides, where a migration only applies because of state some earlier manual fix
# left behind.
#
# Usage:
#   scripts/rehearse-migrations.sh                  # uses $DATABASE_URL
#   DATABASE_URL=postgres://... scripts/rehearse-migrations.sh
#
# Exit codes: 0 all migrations applied · 1 a migration failed (name + SQL error
# printed) · 2 preconditions not met.

set -Eeuo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/postgres}"
MIGRATIONS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/supabase/migrations"
SHIM="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/supabase/shim.sql"

command -v psql >/dev/null 2>&1 || { echo "psql not found on PATH"; exit 2; }
[ -d "$MIGRATIONS_DIR" ] || { echo "no migrations dir at $MIGRATIONS_DIR"; exit 2; }
[ -f "$SHIM" ]           || { echo "no shim at $SHIM"; exit 2; }

psql_run() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q "$@"; }

echo "→ waiting for postgres"
for i in $(seq 1 30); do
  psql "$DATABASE_URL" -c 'select 1' >/dev/null 2>&1 && break
  [ "$i" = 30 ] && { echo "postgres never became ready at $DATABASE_URL"; exit 2; }
  sleep 1
done

echo "→ applying Supabase shim"
psql_run -f "$SHIM"

# pg_cron and pg_net are Supabase-managed and cannot be installed in a stock
# container; supabase/shim.sql already provides the cron.* and net.* surface the
# migrations call. Strip only those CREATE EXTENSION lines — every other
# statement in every migration is applied verbatim, so a genuine syntax error or
# a reference to a missing table still fails here exactly as it would in Supabase.
strip_unavailable_extensions() {
  sed -E '/[Cc][Rr][Ee][Aa][Tt][Ee] +[Ee][Xx][Tt][Ee][Nn][Ss][Ii][Oo][Nn].*(pg_cron|pg_net)/d' "$1"
}

# A ratchet, not a clean sheet. 24 of the 71 committed migrations do not apply to
# an empty database — see supabase/migrations-known-broken.txt for each one, the
# error, and why. Those are recorded as the baseline so this job can block the
# NEXT broken migration without first requiring a schema-archaeology project.
# Anything not on the list must apply cleanly.
KNOWN_BROKEN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/supabase/migrations-known-broken.txt"
is_known_broken() {
  [ -f "$KNOWN_BROKEN" ] || return 1
  grep -v '^#' "$KNOWN_BROKEN" | grep -q "^$1 *|"
}

total=0
applied=0
expected_failures=0
new_failures=0
fixed=()

for f in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
  name="$(basename "$f")"
  total=$((total + 1))
  if strip_unavailable_extensions "$f" | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q >/dev/null 2>/tmp/rehearse_err; then
    applied=$((applied + 1))
    if is_known_broken "$name"; then
      # Good news that must not pass silently — a fixed migration has to leave the
      # baseline, or the list rots into a permanent excuse.
      fixed+=("$name")
    fi
  elif is_known_broken "$name"; then
    expected_failures=$((expected_failures + 1))
    echo "  skip $name (known broken)"
  else
    new_failures=$((new_failures + 1))
    echo ""
    echo "✗ MIGRATION FAILED: $name"
    echo "──────────────────────────────────────────────────────────────"
    grep -m1 '^ERROR' /tmp/rehearse_err | sed 's/^/  /' || sed 's/^/  /' /tmp/rehearse_err
    echo "──────────────────────────────────────────────────────────────"
    echo ""
    echo "This migration does not apply to a clean database, and it is not on the"
    echo "known-broken baseline. Fix it before merging — if it only works against"
    echo "production, production is carrying state that no migration creates, and a"
    echo "rebuild from these files cannot reproduce it."
    exit 1
  fi
done

echo ""
echo "→ $applied of $total migrations applied clean ($expected_failures known-broken skipped)"

if [ ${#fixed[@]} -gt 0 ]; then
  echo ""
  echo "✗ THESE MIGRATIONS NOW APPLY CLEANLY BUT ARE STILL ON THE BASELINE:"
  printf '    %s\n' "${fixed[@]}"
  echo ""
  echo "Remove them from supabase/migrations-known-broken.txt. The list only shrinks;"
  echo "leaving a fixed migration on it hides the next real regression behind it."
  exit 1
fi

# The rehearsal is only worth as much as what it asserts afterwards. A migration
# set can apply perfectly and still not create a table the app queries every day —
# that is exactly how a phantom table hides, because PostgREST answers a query
# against a missing table with an empty result rather than an error.
echo "→ checking every table the frontend queries actually exists"
queried=$(grep -rhoE '\.from\("[a-z0-9_]+"\)' src/ 2>/dev/null \
  | sed -E 's/.*\.from\("([a-z0-9_]+)"\).*/\1/' | sort -u)

# Storage buckets, not relations. `supabase.storage` is frequently on the line
# above the `.from(...)` call, so no line-based grep can tell the two apart —
# hence an explicit list. Add a bucket here when one is introduced.
STORAGE_BUCKETS="avatars"
queried=$(echo "$queried" | grep -vxF "$STORAGE_BUCKETS" || true)
existing=$(psql "$DATABASE_URL" -At -c \
  "select tablename from pg_tables where schemaname='public'
   union select viewname from pg_views where schemaname='public'" | sort -u)

# Relations that exist in production but that no migration creates — the same
# dashboard-created debt as cause #2 in migrations-known-broken.txt. Listed here
# so a genuinely phantom relation (missing in production too, i.e. a dead feature)
# still fails the build. Verified present in production before being added.
DASHBOARD_ONLY="profiles"

missing=$(comm -23 <(echo "$queried") <(echo "$existing") | grep -vxF "$DASHBOARD_ONLY" || true)
if [ -n "$missing" ]; then
  echo ""
  echo "✗ PHANTOM RELATIONS — queried by src/ but created by no migration:"
  echo "$missing" | sed 's/^/    /'
  echo ""
  echo "Every read against these silently returns an empty list in the browser,"
  echo "so the feature is dead without a single error — PostgREST answers a query"
  echo "against a missing relation with [] rather than an error. Add the migration,"
  echo "or remove the query."
  exit 1
fi

echo "→ all $(echo "$queried" | wc -w | tr -d ' ') queried relations exist (excluding known dashboard-only: $DASHBOARD_ONLY)"
echo ""
echo "✓ rehearsal passed"
