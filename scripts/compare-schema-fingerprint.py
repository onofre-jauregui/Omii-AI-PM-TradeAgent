#!/usr/bin/env python3
"""Compare two public-schema catalog fingerprints and report what differs.

Both files are the JSON emitted by scripts/schema-fingerprint.sql: lists of
fully-qualified object descriptors keyed by kind. Comparison is by name and
definition, never by count — a rebuilt schema can carry exactly as many policies
as production while none of them are the same policy, which is what happened
here on 2026-08-06.

    compare-schema-fingerprint.py <expected.json> <actual.json>

Exit 0 when identical, 1 when anything differs. Missing objects print first,
because a missing RLS policy is how a table ends up readable by `anon`.
"""
import json
import sys

KIND_LABEL = {
    "columns": "column",
    "views": "view",
    "routines": "function",
    "policies": "RLS policy",
    "indexes": "index",
    "constraints": "constraint",
    "triggers": "trigger",
}


def load(path):
    with open(path) as handle:
        return json.load(handle)


def main():
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2

    expected, actual = load(sys.argv[1]), load(sys.argv[2])
    drift = False

    # Underscore keys are documentation carried inside the fingerprint (the known
    # production delta), not object lists to compare.
    kinds = {k for k in set(expected) | set(actual) if not k.startswith("_")}
    for kind in sorted(kinds):
        want = set(expected.get(kind) or [])
        got = set(actual.get(kind) or [])
        missing, extra = sorted(want - got), sorted(got - want)
        if not missing and not extra:
            print(f"  {KIND_LABEL.get(kind, kind):11} {len(got):4}  ok")
            continue

        drift = True
        print(f"  {KIND_LABEL.get(kind, kind):11} {len(got):4}  "
              f"DRIFT — {len(missing)} missing, {len(extra)} unexpected")
        for item in missing:
            print(f"      missing     {item}", file=sys.stderr)
        for item in extra:
            print(f"      unexpected  {item}", file=sys.stderr)

    return 1 if drift else 0


if __name__ == "__main__":
    sys.exit(main())
