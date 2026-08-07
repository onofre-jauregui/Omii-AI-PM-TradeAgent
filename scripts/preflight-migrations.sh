#!/usr/bin/env bash
# Dry-run every pending migration against a real Supabase project, writing nothing.
#
# Applies the whole pending set, in order, inside one transaction that always ends
# in ROLLBACK. A migration that would fail against that project fails here instead
# — before the first byte is committed.
#
#   SUPABASE_ACCESS_TOKEN=... PROJECT_REF=... ./scripts/preflight-migrations.sh
#
# Why this exists: on 2026-08-07 the dev → main promotion applied
# 20260316000000_capture_dashboard_era_tables to production, then died on
# 20260406_auto_reflect_cron, leaving the database one migration into a
# thirty-six-migration run and blocking the edge-function deploy behind it. Both
# failures were Supabase-specific and neither was reachable from
# scripts/rehearse-migrations.sh, which replays into stock Postgres with
# scripts/supabase-shim.sql standing in for the platform:
#
#   · `CREATE EXTENSION IF NOT EXISTS pg_cron` is not a no-op on Supabase. The
#     platform runs an after-create hook that re-issues its privilege grants, and
#     `revoke all on table cron.job from postgres` inside it raises
#     `2BP01: dependent privileges exist`. Stock Postgres has no such hook.
#   · `ON CONFLICT (user_id)` in 20260719_realmoney_foundation lost its constraint
#     when 20260807 replaced it with UNIQUE (user_id, mode). The rehearsal replays
#     from zero, so it never saw the intermediate state a real database is in.
#
# The rehearsal proves the migration set rebuilds a database from nothing. This
# proves it can be replayed onto the database it will actually be replayed onto.
# Both are needed; neither substitutes for the other.
#
# Ordering is preserved because the whole set shares one transaction — a migration
# may depend on the one before it. On failure the set is re-run file-by-file, each
# in its own rolled-back transaction, to name the culprit; a file that only fails
# in the second phase is order-dependent, not broken, and is reported as such.
#
# Exit codes:  0 every pending migration replays clean · 1 one would fail · 2 preconditions unmet
set -euo pipefail

: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN is required}"
: "${PROJECT_REF:?PROJECT_REF is required}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PREFLIGHT_MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"
[[ -d "$PREFLIGHT_MIGRATIONS_DIR" ]] || { echo "::error::missing migrations dir: $PREFLIGHT_MIGRATIONS_DIR" >&2; exit 2; }

python3 - <<'PY'
import glob, json, os, subprocess, sys

TOKEN = os.environ["SUPABASE_ACCESS_TOKEN"]
REF = os.environ["PROJECT_REF"]
MIGRATIONS = os.environ["PREFLIGHT_MIGRATIONS_DIR"]
URL = f"https://api.supabase.com/v1/projects/{REF}/database/query"


def query(sql):
    """Returns (ok, payload). Never raises — a transport failure is a preflight failure."""
    proc = subprocess.run(
        ["curl", "-s", "--max-time", "180", "-X", "POST", URL,
         "-H", f"Authorization: Bearer {TOKEN}",
         "-H", "Content-Type: application/json",
         "-d", json.dumps({"query": sql})],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return False, f"curl exited {proc.returncode}: {proc.stderr.strip()[:200]}"
    try:
        payload = json.loads(proc.stdout)
    except ValueError:
        return False, f"unparseable response: {proc.stdout[:200]}"
    # The Management API returns a list of rows on success and an object carrying
    # `message` on error, so the shape itself is the signal.
    if isinstance(payload, dict) and "message" in payload:
        return False, payload["message"]
    return True, payload


ok, applied_rows = query("SELECT version FROM supabase_migrations.schema_migrations")
if not ok:
    print(f"::error::Could not read migration history from {REF}: {applied_rows}")
    sys.exit(2)
applied = {row["version"] for row in applied_rows}

files = sorted(glob.glob(os.path.join(MIGRATIONS, "*.sql")))
if not files:
    print(f"::error::No migrations found in {MIGRATIONS}")
    sys.exit(2)

# A date shared by more than one migration is not a usable key, so the legacy
# date-only prefix is only trusted when it identifies exactly one file. Same rule
# the apply loop in .github/workflows/ci.yml uses — the two must agree or this
# would rehearse a different set than the one that runs.
stems = [os.path.basename(f)[:-4] for f in files]
counts = {}
for stem in stems:
    counts[stem.split("_")[0]] = counts.get(stem.split("_")[0], 0) + 1
ambiguous = {date for date, n in counts.items() if n > 1}

pending = []
for path, stem in zip(files, stems):
    legacy = stem.split("_")[0]
    if stem in applied:
        continue
    if legacy not in ambiguous and legacy in applied:
        continue
    pending.append((stem, path))

if not pending:
    print(f"Preflight: nothing pending on {REF}.")
    sys.exit(0)

print(f"Preflight: replaying {len(pending)} pending migration(s) against {REF} in a rolled-back transaction.")

combined = "BEGIN;\n" + "\n".join(open(p).read() for _, p in pending) + "\nROLLBACK;"
ok, err = query(combined)
if ok:
    for stem, _ in pending:
        print(f"  ok    {stem}")
    print(f"\nPreflight passed: all {len(pending)} pending migration(s) replay clean. Nothing was committed.")
    sys.exit(0)

# The combined run tells us the set is broken but not which file broke it. Isolate.
print("::group::Preflight failed — isolating the migration responsible")
print(f"combined error: {err.splitlines()[0] if err else err}")
culprits = []
for stem, path in pending:
    isolated_ok, isolated_err = query("BEGIN;\n" + open(path).read() + "\nROLLBACK;")
    if isolated_ok:
        print(f"  ok    {stem}")
    else:
        culprits.append((stem, isolated_err))
        print(f"  FAIL  {stem}")
print("::endgroup::")

if not culprits:
    # Every file passes alone but the ordered set does not: a later migration
    # conflicts with an earlier one only once both are present.
    print("::error::Preflight failed for the migration set as a whole, though every file "
          f"passes in isolation — this is an ordering conflict, not a single bad file. "
          f"First error: {err.splitlines()[0] if err else err}")
    sys.exit(1)

for stem, message in culprits:
    first = message.splitlines()[0] if message else message
    print(f"::error file=supabase/migrations/{stem}.sql::{stem} cannot be replayed onto {REF}: {first}")
print(f"\n{len(culprits)} migration(s) would fail. Nothing was applied.")
sys.exit(1)
PY
