# Documentation Index — Omii-AI-PM-TradeAgent

Currency dashboard for the project's managed docs. Check here before trusting a doc is current.

Every `Updated` date below is the file's last commit date (`git log -1 --date=short -- <file>`), not an estimate. Nine rows previously carried no date at all while asserting `current`; those were recoverable from git, so they are filled in rather than left blank.

| Doc | Version | Updated | Status | Owner |
|-----|---------|---------|--------|-------|
| [DESIGN-REPORT.md](../DESIGN-REPORT.md) | 1 | 2026-07-30 | draft — §5 Traceability predates the 2026-08-04 E2E work | Onofre |
| [README.md](../README.md) | — | 2026-08-04 | current | Onofre |
| [CLAUDE.md](../CLAUDE.md) | — | 2026-08-04 | current | Onofre |
| [DECISIONS.md](../DECISIONS.md) | — | 2026-08-06 | current (append-only log) | Onofre |
| [GOALS.md](../GOALS.md) | — | 2026-04-27 | stale — predates live money | Onofre |
| [PRODUCT.md](../PRODUCT.md) | — | 2026-07-10 | current | Onofre |
| [ROADMAP.md](../ROADMAP.md) | — | 2026-04-27 | stale — predates live money | Onofre |
| [TASKS.md](../TASKS.md) | — | 2026-08-04 | current | Onofre |
| [docs/DISASTER-RECOVERY.md](DISASTER-RECOVERY.md) | 2 | 2026-08-06 | current | Onofre |
| [docs/system-report.md](system-report.md) | 2.0 | 2026-07-23 | stale — predates the canary gate and drift checks | Onofre |
| [docs/REALMONEY-RUNBOOK.md](REALMONEY-RUNBOOK.md) | — | 2026-08-06 | current | Onofre |
| [docs/runbooks/promotion-rollback.md](runbooks/promotion-rollback.md) | — | 2026-08-04 | current (§2a not yet exercised live) | Onofre |
| [docs/runbooks/signal-recovery.md](runbooks/signal-recovery.md) | — | 2026-08-01 | current (not yet executed) | Onofre |
| [docs/observability.md](observability.md) | — | 2026-05-16 | stale — predates the canary/drift/health-check apparatus | Onofre |
| [docs/backtesting.md](backtesting.md) | — | 2026-04-27 | stale — predates live money | Onofre |
| [docs/health-log.md](health-log.md) | — | ongoing | current (append-only log) | health-check agent |
| [docs/improvement-log.md](improvement-log.md) | — | ongoing | current (append-only log) | health-check agent |
| [docs/spec-strategy-cleanup-and-tests.md](spec-strategy-cleanup-and-tests.md) | — | 2026-04-27 | stale — predates live money | Onofre |
| [docs/design/full-transaction-cost.md](design/full-transaction-cost.md) | — | 2026-07-23 | current | Onofre |
| [docs/analysis/v2-validation-queries.sql](analysis/v2-validation-queries.sql) | — | 2026-08-06 | current (analysis queries, run by hand) | Onofre |
| [docs/compliance/internal-audit-2026-06-13.md](compliance/internal-audit-2026-06-13.md) | — | 2026-06-13 | superseded by DESIGN-REPORT.md §6 audit (2026-07-30) | Onofre |
| [docs/case-studies/was-acted-on-signal-bug.md](case-studies/was-acted-on-signal-bug.md) | — | 2026-07-10 | current (postmortem) | Onofre |

## Notes

- `DESIGN-REPORT.md` is the current behavioral spec and functional-test eval target — see its §5 Traceability for what has automated coverage today versus what is still a gap. That section is behind: it was written 2026-07-30, before the `dashboard-truth` and `production-hardening` suites landed.
- **Five docs are marked `stale`** rather than `current`: all four dated 2026-04-27 plus `observability.md` (2026-05-16) and `system-report.md` (2026-07-23). They describe a product that had not yet taken live money and has since gained a canary gate, function-drift checks, billing enforcement and a migration-rehearsal harness. Marked honestly instead of asserted current — read them as history until revised.
- Docs without a tracked version predate the frontmatter convention in `~/.claude/DOCUMENTATION.md`; bump them to the versioned format the next time they are materially edited.
