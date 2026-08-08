#!/usr/bin/env bash
# Prove that supabase/migrations/ alone rebuilds the database from zero.
#
# Runs every migration into a throwaway Postgres, twice, and asserts the rebuilt
# catalog matches scripts/expected-schema.json object-for-object. Never connects
# to a hosted Supabase project and never writes anything durable.
#
#   ./scripts/rehearse-migrations.sh                     # docker, auto lifecycle
#   ./scripts/rehearse-migrations.sh --keep              # leave the database up
#   ./scripts/rehearse-migrations.sh --write-fingerprint # re-record expected-schema.json
#   REHEARSAL_DSN=postgres://... ./scripts/rehearse-migrations.sh
#
# Why this exists: production had 35 public tables while the migration set created
# 30, so the schema could not be rebuilt from git at all. CommStack lost its
# Supabase project outright on 2026-07-20 and recovered only because its migrations
# replayed clean. This is the check that keeps that true here.
#
# Exit codes:  0 rebuilt clean · 1 a migration failed or the catalog drifted · 2 preconditions unmet
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"
SHIM="$REPO_ROOT/scripts/supabase-shim.sql"
EXPECTED="$REPO_ROOT/scripts/expected-schema.json"
# The XXXXXX suffix is required by GNU coreutils' mktemp; BSD/macOS mktemp accepts
# a bare -t prefix, so a template without it works locally and fails on every
# ubuntu-latest runner with "too few X's in template" — which is why this job had
# never once passed in CI.
FINGERPRINT_OUT="$(mktemp -t rehearsal-fingerprint.XXXXXX)"
CONTAINER="tradeagent-migration-rehearsal"
PGIMAGE="${REHEARSAL_PG_IMAGE:-postgres:15-alpine}"
KEEP=0
SURVEY=0
WRITE_FINGERPRINT=0
for arg in "$@"; do
  case "$arg" in
    --keep)   KEEP=1 ;;
    # Apply every migration and report ALL failures instead of stopping at the
    # first. Never a passing mode — it always exits non-zero if anything failed.
    # Exists so a large drift can be diagnosed in one run rather than N.
    --survey) SURVEY=1; KEEP=1 ;;
    # Overwrite scripts/expected-schema.json with what this run produced. Only
    # correct when the schema change is intentional — the diff belongs in the
    # same commit and the same review as the migration that caused it.
    --write-fingerprint) WRITE_FINGERPRINT=1 ;;
  esac
done

red()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }

[[ -f "$SHIM" ]]           || { red "missing shim: $SHIM"; exit 2; }
[[ -d "$MIGRATIONS_DIR" ]] || { red "missing migrations dir: $MIGRATIONS_DIR"; exit 2; }
[[ -f "$EXPECTED" || $WRITE_FINGERPRINT -eq 1 ]] || { red "missing fingerprint: $EXPECTED"; exit 2; }

# Three ways to get a throwaway Postgres, in preference order:
#   dsn    — REHEARSAL_DSN supplied. How CI runs it, against its own empty
#            `postgres` service container. Used as-is; nothing is created.
#   local  — a running local cluster. A scratch DATABASE is created and dropped.
#   docker — spin up a container. Fallback when there is no local cluster.
MODE=""
SCRATCH_DB="${REHEARSAL_DB:-tradeagent_migration_rehearsal}"

# The shim shadows the platform's own auth schema and helper functions, so
# pointing this at a hosted project would corrupt it. Refuse before anything runs.
if [[ -n "${REHEARSAL_DSN:-}" ]]; then
  case "$REHEARSAL_DSN" in
    *supabase.co*|*supabase.com*|*pooler.supabase*)
      red "REHEARSAL_DSN points at a hosted Supabase project. This script applies"
      red "scripts/supabase-shim.sql, a local test fixture that would shadow the"
      red "platform's own auth schema. Refusing."
      exit 2 ;;
  esac
  MODE=dsn
  command -v psql >/dev/null 2>&1 || { red "psql not found"; exit 2; }
  PSQL=(psql "$REHEARSAL_DSN" -v ON_ERROR_STOP=1 -q --no-psqlrc)
elif command -v psql >/dev/null 2>&1 && pg_isready -q 2>/dev/null; then
  MODE=local
  # This branch runs DROP DATABASE. Refuse any name that isn't an obvious throwaway.
  case "$SCRATCH_DB" in
    *rehearsal*) ;;
    *) red "REHEARSAL_DB must contain 'rehearsal' — refusing to touch '$SCRATCH_DB'"; exit 2 ;;
  esac
  PSQL=(psql -d "$SCRATCH_DB" -v ON_ERROR_STOP=1 -q --no-psqlrc)
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  MODE=docker
  PSQL=(docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q --no-psqlrc)
else
  red "no throwaway Postgres available. Do one of:"
  red "  · start a local cluster   (brew services start postgresql@17)"
  red "  · start Docker"
  red "  · set REHEARSAL_DSN to an empty local database"
  exit 2
fi

cleanup() {
  rm -f "$FINGERPRINT_OUT"
  case "$MODE" in
    local)
      if [[ $KEEP -eq 0 ]]; then
        psql -d postgres -q -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\" WITH (FORCE);" >/dev/null 2>&1 || true
      else
        dim "scratch database kept: psql -d $SCRATCH_DB"
      fi ;;
    docker)
      if [[ $KEEP -eq 0 ]]; then
        docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
      else
        dim "container kept: docker exec -it $CONTAINER psql -U postgres"
      fi ;;
  esac
}
trap cleanup EXIT

case "$MODE" in
  local)
    dim "rehearsing into local database $SCRATCH_DB"
    psql -d postgres -q -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\" WITH (FORCE);"
    psql -d postgres -q -c "CREATE DATABASE \"$SCRATCH_DB\";" ;;
  docker)
    dim "rehearsing into a fresh $PGIMAGE container"
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=rehearsal -e POSTGRES_HOST_AUTH_METHOD=trust "$PGIMAGE" >/dev/null
    for _ in $(seq 1 60); do
      docker exec "$CONTAINER" pg_isready -U postgres -q 2>/dev/null && break
      sleep 1
    done
    docker exec "$CONTAINER" pg_isready -U postgres -q || { red "postgres never became ready"; exit 2; } ;;
  dsn)
    dim "rehearsing into the supplied REHEARSAL_DSN" ;;
esac

# One pass = shim + every migration in sorted order. Output is captured rather
# than streamed so a clean run is one line per migration and only a failure dumps
# its stderr.
run_pass() {
  local pass="$1" applied=0 name output
  if ! output="$("${PSQL[@]}" -f - < "$SHIM" 2>&1)"; then
    red "FAIL  supabase-shim.sql"; red "$output"; return 1
  fi
  local failed=0
  for migration in "$MIGRATIONS_DIR"/*.sql; do
    name="$(basename "$migration")"
    if output="$("${PSQL[@]}" -f - < "$migration" 2>&1)"; then
      applied=$((applied + 1))
    elif [[ $SURVEY -eq 1 ]]; then
      failed=$((failed + 1))
      red "FAIL  $name"
      grep -E '^psql:.*(ERROR|FATAL)' <<<"$output" | head -3 | sed 's/^/        /' >&2
    else
      red "FAIL  $name  (pass $pass, after $applied clean)"
      red "$output"
      return 1
    fi
  done
  APPLIED=$applied
  if [[ $SURVEY -eq 1 && $failed -gt 0 ]]; then
    red ""
    red "survey: $failed migration(s) failed, $applied applied clean"
    return 1
  fi
  return 0
}

started=$SECONDS

if ! run_pass 1; then
  red ""
  red "The migration set does NOT rebuild the database from zero."
  red "Fix the migration above before relying on docs/DISASTER-RECOVERY.md."
  exit 1
fi
grn "pass 1: $APPLIED migrations applied clean from an empty database"

# Second pass into the SAME database. Every migration must be re-appliable, since
# CI's runner replays a whole file when a partial apply is retried and nothing
# records statement-level progress.
if ! run_pass 2; then
  red ""
  red "A migration is not idempotent — it applies once but fails on replay."
  red "CI re-applies whole files on retry, so this breaks recovery."
  exit 1
fi
grn "pass 2: all $APPLIED migrations re-applied clean (idempotent)"

echo
dim "Rebuilt from zero in $((SECONDS - started))s"

# The rebuilt catalog is compared to the committed fingerprint by NAME, not by
# count. Counts are the wrong check: on 2026-08-06 this script reported
# "36 tables · 7 views · 12 functions · 52 policies · 126 indexes — counts match"
# while twelve RLS policies, three column types and four constraints differed
# from production. Every total lined up; the schemas did not.
"${PSQL[@]}" -tA --no-psqlrc -f "$REPO_ROOT/scripts/schema-fingerprint.sql" > "$FINGERPRINT_OUT"

if [[ $WRITE_FINGERPRINT -eq 1 ]]; then
  # Carry forward every "_"-prefixed key from the existing fingerprint.
  #
  # Those keys are prose, not schema: compare-schema-fingerprint.py skips them
  # by design, so they are the only place the file records WHY it looks the way
  # it does — which objects production is missing and why, which deltas were
  # reviewed and accepted. Dumping the raw catalog over the top erased all of
  # it, and it erased silently: the comparator ignores the keys, so CI stayed
  # green while the explanation disappeared. That happened on 2026-08-07 with
  # the drawdown-gear regeneration, taking with it the note that production has
  # 11 user_ids with duplicate risk_settings rows — a fact that then had to be
  # rediscovered by hand.
  #
  # Regenerated schema always wins for real keys; annotations survive. If an
  # annotation goes stale, edit or delete it deliberately.
  python3 - "$FINGERPRINT_OUT" "$EXPECTED" <<'PY'
import json
import os
import sys

fingerprint_path, expected_path = sys.argv[1], sys.argv[2]

with open(fingerprint_path) as handle:
    merged = json.load(handle)

if os.path.exists(expected_path):
    with open(expected_path) as handle:
        previous = json.load(handle)
    carried = [k for k in previous if k.startswith("_")]
    for key in carried:
        merged[key] = previous[key]
    if carried:
        print(f"carried forward {len(carried)} annotation(s): {', '.join(sorted(carried))}")

with open(expected_path, "w") as handle:
    json.dump(merged, handle, indent=1, sort_keys=True)
PY
  grn "wrote $EXPECTED"
  exit 0
fi

if ! python3 "$REPO_ROOT/scripts/compare-schema-fingerprint.py" "$EXPECTED" "$FINGERPRINT_OUT"; then
  red ""
  red "The rebuilt schema does not match scripts/expected-schema.json."
  red "Either a migration was lost, or the fingerprint needs regenerating in the"
  red "same commit as the schema change that moved it:"
  red "    ./scripts/rehearse-migrations.sh --write-fingerprint"
  exit 1
fi

# ── Planted-canary negative test ──────────────────────────────────────────
# The fingerprint above proves the schema LOOKS right (the index exists by
# name) — it does not prove the constraint actually rejects bad data. That gap
# is exactly what let risk_settings_user_mode_idx be recorded as applied to
# production twice while never enforcing anything there. Prove it here by
# planting a real duplicate and asserting the second insert is rejected; if
# it's silently allowed, fail loud instead of trusting that the index merely
# exists.
if ! "${PSQL[@]}" -f - <<'SQL'
INSERT INTO public.risk_settings
  (user_id, mode, max_position_size, max_open_positions, max_daily_loss, max_drawdown_pct, allocated_capital, max_daily_trades)
VALUES ('00000000-0000-0000-0000-000000000000', 'paper', 20, 3, 100, 10, 500, 30);

DO $$
BEGIN
  INSERT INTO public.risk_settings
    (user_id, mode, max_position_size, max_open_positions, max_daily_loss, max_drawdown_pct, allocated_capital, max_daily_trades)
  VALUES ('00000000-0000-0000-0000-000000000000', 'paper', 20, 3, 100, 10, 500, 30);
  RAISE EXCEPTION 'CANARY FAILED: duplicate (user_id, mode) insert succeeded — risk_settings_user_mode_idx is not enforcing uniqueness';
EXCEPTION
  WHEN unique_violation THEN
    RAISE NOTICE 'canary: duplicate (user_id, mode) correctly rejected by risk_settings_user_mode_idx';
END $$;

DELETE FROM public.risk_settings WHERE user_id = '00000000-0000-0000-0000-000000000000';
SQL
then
  red ""
  red "Planted-canary test failed: risk_settings allowed a duplicate (user_id, mode)"
  red "row. The unique index exists in the fingerprint but is not actually enforcing"
  red "uniqueness against real inserts — do not trust it applied to production either."
  exit 1
fi
grn "planted canary: risk_settings (user_id, mode) uniqueness verified by rejection, not just by presence"

echo
grn "Rebuilt from zero — $APPLIED migrations applied clean, twice, catalog matches."
