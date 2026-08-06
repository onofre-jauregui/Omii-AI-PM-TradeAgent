#!/usr/bin/env bash
# Prove that supabase/migrations/ alone rebuilds the database from zero.
#
# Runs every migration into a throwaway Postgres, twice, and asserts the
# resulting object counts match scripts/expected-schema-counts.json. Never
# connects to a hosted Supabase project and never writes anything durable.
#
#   ./scripts/rehearse-migrations.sh            # docker, auto lifecycle
#   ./scripts/rehearse-migrations.sh --keep     # leave the database up to inspect
#   REHEARSAL_DSN=postgres://... ./scripts/rehearse-migrations.sh
#
# Why this exists: production had 35 public tables while the migration set created
# 30, so the schema could not be rebuilt from git at all. CommStack lost its
# Supabase project outright on 2026-07-20 and recovered only because its migrations
# replayed clean. This is the check that keeps that true here.
#
# Exit codes:  0 rebuilt clean · 1 a migration failed or counts drifted · 2 preconditions unmet
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"
SHIM="$REPO_ROOT/scripts/supabase-shim.sql"
EXPECTED="$REPO_ROOT/scripts/expected-schema-counts.json"
CONTAINER="tradeagent-migration-rehearsal"
PGIMAGE="${REHEARSAL_PG_IMAGE:-postgres:15-alpine}"
KEEP=0
SURVEY=0
for arg in "$@"; do
  case "$arg" in
    --keep)   KEEP=1 ;;
    # Apply every migration and report ALL failures instead of stopping at the
    # first. Never a passing mode — it always exits non-zero if anything failed.
    # Exists so a large drift can be diagnosed in one run rather than N.
    --survey) SURVEY=1; KEEP=1 ;;
  esac
done

red()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }

[[ -f "$SHIM" ]]           || { red "missing shim: $SHIM"; exit 2; }
[[ -d "$MIGRATIONS_DIR" ]] || { red "missing migrations dir: $MIGRATIONS_DIR"; exit 2; }
[[ -f "$EXPECTED" ]]       || { red "missing expected counts: $EXPECTED"; exit 2; }

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

read -r tables views functions policies indexes <<<"$(
  "${PSQL[@]}" -tA -F' ' -c "
    SELECT
      (SELECT count(*) FROM pg_tables    WHERE schemaname = 'public'),
      (SELECT count(*) FROM pg_views     WHERE schemaname = 'public'),
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'),
      (SELECT count(*) FROM pg_policies  WHERE schemaname = 'public'),
      (SELECT count(*) FROM pg_indexes   WHERE schemaname = 'public');"
)"

echo
dim "Rebuilt from zero in $((SECONDS - started))s"

# Counts are asserted, not printed for someone to eyeball. A dropped table shows
# up as a smaller number, and a smaller number nobody compares is not a check.
python3 - "$EXPECTED" "$tables" "$views" "$functions" "$policies" "$indexes" <<'PY'
import json, sys
exp = json.load(open(sys.argv[1]))
got = dict(zip(["tables", "views", "functions", "policies", "indexes"], map(int, sys.argv[2:7])))
bad = []
for k, want in exp.items():
    if k.startswith("_"):
        continue
    if got.get(k) != want:
        bad.append(f"  {k:10} expected {want:4}  got {got.get(k)}")
for k, v in got.items():
    print(f"  {k:10} {v}")
if bad:
    print("\nSCHEMA DRIFT — the rebuilt schema does not match the recorded target:", file=sys.stderr)
    print("\n".join(bad), file=sys.stderr)
    print("\nEither a migration was lost, or the target in scripts/expected-schema-counts.json\n"
          "needs updating in the same commit as the schema change that moved it.", file=sys.stderr)
    sys.exit(1)
PY

echo
grn "Rebuilt from zero — $APPLIED migrations applied clean, twice, counts match."
