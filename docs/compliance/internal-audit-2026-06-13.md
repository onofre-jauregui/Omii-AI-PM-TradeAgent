# Internal Compliance Audit — Omii AI TradeAgent
**Date:** June 13, 2026  
**Prepared by:** Internal (pre-external-audit self-assessment)  
**Classification:** Confidential — Internal Use Only  
**Status:** DRAFT — Pending Legal Review

---

## Executive Summary

This document records the results of an internal pre-audit compliance review of the Omii AI TradeAgent platform — a SaaS product where users connect their Kalshi API keys and an AI agent autonomously trades CFTC-regulated prediction market event contracts on their behalf for a subscription fee.

**Bottom line:** Two regulatory registrations are structurally required before the first paying stranger-user. One critical security vulnerability allows unauthenticated users to execute trades in any user's account. Multiple representations in public-facing copy (performance statistics, data deletion promises) are not backed by implemented code.

The platform has strong foundational compliance infrastructure (end-to-end encryption, server-enforced risk controls, multi-tenancy RLS, prompt injection defense) that positions it well for remediation. The gaps are remediable; none require architectural redesign.

### Finding Summary

| Category | BLOCKING | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Regulatory (what must exist) | 3 | 1 | 2 | 1 |
| System (what the code does) | 2 | 4 | 3 | 3 |

---

## Scope and Methodology

**Product:** Public SaaS at `kalshitradeagent.com`. Users sign up, complete onboarding, connect their own Kalshi API keys, and activate an AI trading agent that places orders on Kalshi (a CFTC-designated contract market) in their individual accounts. Operator collects a subscription fee. No funds are pooled.

**Regulatory research method:** Web search against primary statutory sources (Cornell LII, CFR, CFTC.gov, NFA.futures.org, Federal Register). All citations are to primary sources unless marked [UNVERIFIED].

**System audit method:** Direct code review of all edge functions, frontend pages, migration files, and shared modules. Findings reference specific file paths and line numbers. No finding is made without reading the relevant file.

**Auditors:** Two independent AI agents — one conducting regulatory research, one conducting system code review — with findings synthesized here.

---

## Part I — Regulatory Landscape

### 1.1 CFTC Commodity Trading Advisor (CTA) Registration

**Verdict: BLOCKING — registration required before first paying user**

**Statute:** CEA § 4m (7 U.S.C. § 6m); 17 CFR Part 4; NFA Compliance Rules

**Analysis:** The CTA definition under 17 C.F.R. § 1.3 covers any person who receives compensation for directing trading or providing trading advice in commodity interests. Kalshi event contracts are CFTC-regulated commodity interests. The platform receives a subscription fee (compensation) and the AI agent autonomously places orders in user accounts (directing trading). This is the classic CTA model — separate account management.

**Exemptions reviewed:**

| Exemption | Condition | Available? |
|-----------|-----------|-----------|
| CEA § 4m(1) — 15-client rule | < 15 clients in 12 months AND does not hold out publicly | **No** — public website (`kalshitradeagent.com`) triggers the "holding out" prong. Per CFTC No-Action Letter tm97-26, any solicitation beyond family/friends/existing business associates constitutes holding out. A public sign-up page is holding out. |
| Rule 4.14(a)(9) — General advice only | Only general, not client-specific advice | **No** — AI trades specific user accounts |
| Rule 4.14(a)(8) — SEC-registered IA | Must be SEC-registered investment adviser | **No** — Kalshi contracts are not securities |
| QEP relief (reinstated Jan 2026) | Must be SEC-registered RIA managing private funds | **No** |

**Conclusion:** No exemption is available once the platform is publicly marketed. CTA registration with the NFA is required.

**What registration entails:**
- Form 7-R via NFA Online Registration System: $200 entity + $85 per principal
- Sole proprietor/designated principal must pass **Series 3** (National Commodity Futures Examination): 120 questions, 70% passing score, $140 exam fee; no employer sponsor required
- NFA Disclosure Document (see §1.6) must be drafted, filed with NFA, and accepted before any client engagement — 14-day target review window
- Annual NFA Member Questionnaire and Registration Update
- Quarterly/annual performance reports (within 45 days of period end; $200/day late penalty)
- 5-year recordkeeping of all advisory materials, trade decisions, client communications, and fee records (first 2 years readily accessible)
- Written supervision protocol for the AI system under CFTC Regulation 166.3
- Written Information Security and Systems Policy (ISSP), annual review, disaster recovery testing

**Estimated cost:** Initial registration + exam: ~$500–600. First-year legal (Disclosure Document drafting + compliance setup): $10,000–20,000. Ongoing annual: $2,000–5,000.

**Consequence of non-compliance:** Civil penalties up to $1 million per violation or triple monetary gain; criminal prosecution possible (up to 5 years imprisonment). CEA anti-fraud provisions apply regardless of registration status. CFTC enforcement of prediction market violations is accelerating — first-ever insider trading enforcement action in event contracts occurred in 2025–2026.

**Sources:** [17 CFR § 4.14](https://www.law.cornell.edu/cfr/text/17/4.14) · [7 U.S.C. § 6m](https://www.law.cornell.edu/uscode/text/7/6m) · [CFTC No-Action tm97-26](https://www.cftc.gov/sites/default/files/tm/letters/97letters/tm97-26.htm) · [NFA — Who Has to Register as CTA](https://www.nfa.futures.org/registration-membership/who-has-to-register/cta.html) · [Morgan Lewis — CFTC Reinstates QEP Exemption (Jan 2026)](https://www.morganlewis.com/pubs/2026/01/cftc-reinstates-cpo-and-cta-registration-relief-related-to-qeps)

---

### 1.2 CFTC Commodity Pool Operator (CPO) Registration

**Verdict: NOT APPLICABLE in current architecture**

A CPO operates a "commodity pool" — an enterprise where funds from multiple persons are combined for trading. In this product, each user connects their own individual Kalshi account. Funds are never commingled. This is the defining characteristic of a CTA (separate account management), not a CPO. CPO registration is not required.

**Watch trigger:** If the product ever moves toward accepting user deposits into an operator-controlled trading account, CPO registration becomes required — at significantly higher burden than CTA.

**Sources:** [7 U.S.C. § 1a(11)](https://www.law.cornell.edu/uscode/text/7/1a) · [17 CFR § 4.5](https://www.law.cornell.edu/cfr/text/17/4.5)

---

### 1.3 Investment Advisers Act / SEC Jurisdiction

**Verdict: NOT APPLICABLE**

The Investment Advisers Act of 1940 (15 U.S.C. § 80b) regulates advice about "securities." Kalshi event contracts are CFTC-regulated commodity contracts, not securities. The CFTC has exclusive jurisdiction over futures and event contracts traded on a designated contract market. The Third Circuit affirmed in April 2026 that CEA's exclusive jurisdiction clause preempts state and parallel SEC interference with CFTC-registered DCM contracts. No SEC registration required; no SEC disclosure regime applies.

**Sources:** [Norton Rose Fulbright — Prediction Markets at a Crossroads (Apr 2026)](https://www.nortonrosefulbright.com/en-us/knowledge/publications/ad8a494a/prediction-markets-at-a-crossroads-preemption-enforcement-and-rulemaking)

---

### 1.4 Kalshi Developer Agreement

**Verdict: BLOCKING — must be reviewed before launch [UNVERIFIED FROM PRIMARY SOURCE]**

Kalshi maintains a Developer Agreement at `kalshi.com/developer-agreement` that governs API use. The exact text was not retrievable during research (rate-limited). Third-party commercial SaaS applications built on Kalshi's API appear to exist in practice (KalshiAI, KalshiSpy), suggesting third-party development is not categorically prohibited. However, whether a commercial SaaS that authenticates using user-provided API keys, re-licenses API access to end users, and charges a subscription fee is permitted — or requires a commercial partnership agreement — is unconfirmed.

**Required action:** Read the full Developer Agreement. Contact Kalshi's partnerships/API team to confirm the product model is permitted before launch. This is a potential existential product risk: Kalshi can terminate API access, which kills the product.

**Sources:** [Kalshi Developer Agreement](https://kalshi.com/developer-agreement) [unread — access blocked] · [Kalshi API Help Center](https://help.kalshi.com/en/articles/13823854-kalshi-api) · [Kalshi API Docs](https://docs.kalshi.com/welcome)

---

### 1.5 State Money Transmitter Licenses

**Verdict: NOT APPLICABLE in current architecture**

MTL requirements attach to entities that receive, hold, or transmit money on behalf of others. The operator never touches user funds — users connect their own Kalshi accounts via API keys, and Kalshi holds the funds. The operator collects subscription fees via Stripe (standard SaaS payment processing, not money transmission). California's Digital Financial Assets Law (effective July 1, 2026) covers digital financial assets (cryptocurrency), not CFTC-regulated prediction market contracts.

**Watch trigger:** If architecture ever changes to accept user funds directly, re-run MTL analysis.

---

### 1.6 NFA Disclosure Document

**Verdict: BLOCKING — must be NFA-accepted before first paying client**

For a registered CTA, a Disclosure Document must be drafted, filed with NFA, and accepted before any client engagement. Required contents under CFTC Reg. 4.34/4.35:

1. Description of trading program (including that it is AI/algorithm-driven, with description of model inputs and decision logic to the extent disclosable)
2. Principal information and business backgrounds
3. Disciplinary history
4. Risk factors: binary outcome risk, loss of total stake, market liquidity risk, AI model risk, settlement risk
5. Fee structure in full
6. Performance results using NFA-mandated methodology, or explicit statement that no prior trading history exists
7. Mandatory risk warning: *"THE RISK OF LOSS IN TRADING COMMODITY FUTURES CONTRACTS CAN BE SUBSTANTIAL. YOU SHOULD THEREFORE CAREFULLY CONSIDER WHETHER SUCH TRADING IS SUITABLE FOR YOU IN LIGHT OF YOUR FINANCIAL CONDITION."*
8. For AI programs specifically: model risk disclosure, limitations, override/supervision description

**Sources:** [NFA CTA Disclosure Documents FAQ](https://www.nfa.futures.org/faqs/members/cta-disclosure-documents.html) · [NFA Annual CTA Requirements](https://www.nfa.futures.org/members/cta/regulatory-obligations/annual-cta-requirements.html)

---

### 1.7 Privacy and Data Protection

**Verdict: PARTIALLY BLOCKING**

**CCPA (Cal. Civil Code § 1798.100 et seq.):** Applies to for-profit businesses meeting revenue/data volume thresholds. Early-stage SaaS likely does not initially meet thresholds. However, a Privacy Policy must exist at launch regardless — absence is a deceptive practice under FTC § 5.

**GLBA (15 U.S.C. § 6801):** Gramm-Leach-Bliley Act applies to "financial institutions significantly engaged in financial activities." A prediction market trading SaaS is arguably a financial institution under GLBA. If so, annual privacy notices to customers disclosing data collection and sharing practices are required from the first paying user.

**California ADMT Rule (effective January 1, 2027):** New automated decision-making opt-out rules require a pre-use notice before deploying automated decisions that substantially replace human decision-making in transactions. An AI agent autonomously trading a user's financial account qualifies. A structured opt-out flow must be operational before January 1, 2027.

**Blocking:** Privacy Policy at launch. Structured ADMT opt-out by January 1, 2027.

**Sources:** [Wipfli — CCPA Fintech Analysis](https://www.wipfli.com/insights/articles/updated-california-data-privacy-laws-expose-fintech-companies-to-costly-compliance-risks)

---

### 1.8 FTC and Consumer Protection

**Verdict: BLOCKING from day one of marketing**

FTC Act § 5 prohibits unfair or deceptive acts or practices. FTC's Operation AI Comply (launched September 2024) has specifically targeted platforms making false AI performance claims. Requirements:

- No specific return projections without verified, representative performance data
- Mandatory past-performance disclaimer adjacent to any historical performance display: *"PAST PERFORMANCE IS NOT NECESSARILY INDICATIVE OF FUTURE RESULTS."*
- Accurate disclosure that trading is performed by an AI agent
- User testimonials must reflect typical experience; atypical results must be disclosed
- Risk warnings must be material and visible — not buried in footer text

**Sources:** [FTC AI Enforcement — Holland & Knight (Jun 2025)](https://www.hklaw.com/en/insights/publications/2025/06/ftc-evaluating-deceptive-artificial-intelligence-claims)

---

### 1.9 CFTC Position Limits

**Verdict: NOT APPLICABLE at SaaS operator level**

CFTC speculative position limits (17 CFR Part 150) apply to 25 specific physical commodity futures — not to prediction market event contracts. Kalshi manages position accountability at the exchange level per its own rulebook (filed with CFTC, amended November 2024 to use "Position Accountability Levels"). Position limits are enforced on individual user accounts by Kalshi directly. The operator's AI trading across multiple user accounts does not aggregate those positions from a CFTC standpoint.

**Operational watch:** If the AI systematically creates correlated positions across many accounts simultaneously, Kalshi's surveillance could flag this as coordinated trading. This is an operational risk, not a registration issue.

**Sources:** [Kalshi Rulebook — Position Accountability (CFTC Filing, Jul 2025)](https://www.cftc.gov/sites/default/files/filings/orgrules/25/07/rules07012525155.pdf)

---

## Part II — System Compliance Audit

Files reviewed: `src/pages/OnboardingPage.tsx`, `src/pages/LandingPage.tsx`, `src/pages/TermsPage.tsx`, `src/pages/PrivacyPage.tsx`, `src/pages/PerformancePage.tsx`, `src/App.tsx`, `supabase/functions/auto-trade/index.ts`, `supabase/functions/auto-settle/index.ts`, `supabase/functions/execute-trade/index.ts`, `supabase/functions/save-kalshi-key/index.ts`, `supabase/functions/_shared/encryption.ts`, `supabase/functions/_shared/kalshi-auth.ts`, `supabase/functions/_shared/risk.ts`, `supabase/functions/_shared/tenant.ts`, all migrations in `supabase/migrations/`.

---

### CRITICAL — C-001: Authentication bypass in `execute-trade`

**File:** `supabase/functions/_shared/tenant.ts:65–76` · `supabase/functions/execute-trade/index.ts:183`

**Current state:** `resolveTenant()` has a second resolution path: if JWT verification fails or no JWT is present, it reads `user_id` from the parsed request body and sets `authenticated: false`. `execute-trade` passes the tenant result to downstream trade execution without ever checking the `authenticated` flag. The flag is written only to a metadata field in a compliance log entry (line ~384).

**Impact:** Any caller with network access to the edge function URL can execute trades under any user's account by supplying a target user's UUID in the POST body. For paper mode this corrupts strategy stats; once live trading is enabled it depletes the victim user's Kalshi balance. The target user's UUID is not secret — it could be leaked via other endpoints or inferred.

**Proof of concept:**
```
POST https://uyfnezxmgwitpzsrnkst.supabase.co/functions/v1/execute-trade
{ "user_id": "<any-user-uuid>", "ticker": "...", "side": "yes", "action": "buy", "price": 50, "amount": 100, "mode": "live" }
```

**Required fix:** After `resolveTenant()`, add a hard gate:
```typescript
if (!authenticated) {
  return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
}
```
The body-based `user_id` fallback in `resolveTenant` was intended for internal service-role cron callers. Those callers must be authenticated via the service role key in the `Authorization` header, not via a body field.

**Severity: CRITICAL**

---

### CRITICAL — C-002: Hardcoded performance statistics on public landing page

**File:** `src/pages/LandingPage.tsx` — `FALLBACK_STATS` constant and hero stats render block

**Current state:** The hero section displays `+37.6% cumulative ROI`, `81% win rate`, and `150 trades`. When the live `platform-stats` edge function call fails, the code silently falls back to hardcoded constants (`totalPnl: 940.30`, `winRate: 81.3`, `tradeCount: 150`). No disclaimer is displayed adjacent to the stat cards or chart. The only disclaimer on the page is a footer line "Not financial advice."

**Impact:** CFTC Regulation 4.41 prohibits presenting hypothetical or simulated performance without required disclosures immediately adjacent to the performance data. The FTC's Operation AI Comply (2024) has issued enforcement actions for false AI performance claims. If these fallback values are not real verified platform performance data, displaying them to prospective subscribers is a material misrepresentation.

**Required fix:**
1. Remove `FALLBACK_STATS` entirely or replace fallback values with zeros
2. Add a prominently placed disclaimer directly on the stat panel (not the footer): *"Simulated paper trading performance. Not indicative of future results. Past performance does not guarantee future returns."*
3. Do not display any specific ROI/win-rate figures until the platform has a real, verified paper-trading track record

**Severity: CRITICAL**

---

### HIGH — H-001: No geographic restriction enforcement

**File:** No geo check exists in any reviewed file — not in `vercel.json`, not in any edge function, not in the signup flow.

**Current state:** Kalshi is a CFTC-designated contract market restricted to US persons under Kalshi's ToS and CFTC regulations. The platform collects no IP-based, address-based, or self-attestation geographic restriction. Any person anywhere in the world can sign up and have the AI trade Kalshi on their behalf.

**Required fix (minimum):** Add a self-attestation checkbox to the signup/onboarding flow: "I confirm I am a US person as defined under CFTC regulations and am eligible to trade on Kalshi." Add explicit territorial restriction to the Terms of Service. Longer-term: Vercel Edge Middleware for country-based blocking or warning.

**Severity: HIGH**

---

### HIGH — H-002: `risk_settings` fail-open — no row equals no protection

**File:** `supabase/functions/auto-trade/index.ts:196–198` · `supabase/functions/_shared/risk.ts:72`

**Current state:** When no `risk_settings` row exists for a user, two inconsistent code paths execute:
- `fetchUserRiskSettings()` in `auto-trade` returns `{ max_open_positions: 10, max_position_size: 500, max_daily_loss: 500, max_drawdown_pct: 20 }` — loose defaults
- `evaluateRisk()` in `risk.ts` returns `{ passed: true }` when `settings` is null — no limits at all

A user who reaches `execute-trade` directly from the dashboard (not through `auto-trade`) hits the `risk.ts` null path. A user with no settings row can have the agent execute up to $5,000 notional exposure with zero configured guardrails.

**Required fix:** Define a single `DEFAULT_RISK_SETTINGS` constant in `risk.ts` with conservative safe values (`max_position_size: 20`, `max_open_positions: 3`) and use it in both `evaluateRisk()` null guard and `fetchUserRiskSettings()`. Eliminate the inconsistency. Add a migration to backfill `risk_settings` rows for any existing user without one.

**Severity: HIGH**

---

### HIGH — H-003: compliance_log has no enforced schema — audit trail is informal

**File:** `supabase/migrations/20260405165717_*.sql` (recreates table without CHECK constraint) · `supabase/functions/auto-trade/index.ts` (inserts ~15 distinct informal event type strings)

**Current state:** The original migration defined a strict `CHECK (event_type IN (...))` allowlist. A later migration dropped and recreated the table with `event_type TEXT NOT NULL DEFAULT 'info'` and no constraint. The compliance log is now used as a general-purpose operational log with informal string event types. A regulatory audit requiring reconstruction of the complete trade lifecycle cannot reliably query by event type because types are unconstrained.

**Required fix:** Migration to separate compliance-critical events (with enforced allowlist: `order_submitted`, `order_filled`, `order_cancelled`, `order_failed`, `risk_check_failed`, `risk_check_passed`, `trading_halted`, `api_error`) from operational events (in a separate `ops_log` table with no constraint). Ensure every trade has a corresponding `order_submitted` and `order_filled` or `order_failed` entry keyed by `trade_id`.

**Severity: HIGH**

---

### HIGH — H-004: Direct browser client write to deprecated `api_keys.encrypted_secret` column

**File:** `src/pages/OnboardingPage.tsx:101–109`

**Current state:** During onboarding, the selected AI model name is upserted directly to `api_keys.encrypted_secret` using the anon Supabase client from the browser with the user's session token, bypassing the edge function encryption path. The column is marked `DEPRECATED: stores plaintext despite misleading name` in the schema.

**Impact:** The model name itself is not a secret, but this pattern is a footgun — any future developer following this pattern for a real credential would store it unencrypted in a column named `encrypted_secret`. Direct browser writes to `api_keys` also bypass the encryption layer contract established by `save-kalshi-key`.

**Required fix:** Remove the direct client-side upsert to `api_keys` from `OnboardingPage.tsx`. Store model preference in `profiles` or a dedicated `user_preferences` table. Create a migration to drop the `encrypted_secret` column.

**Severity: HIGH**

---

### MEDIUM — M-001: Privacy Policy commits to data deletion — no implementation exists

**File:** `src/pages/PrivacyPage.tsx:96` · No deletion endpoint found in any file reviewed

**Current state:** The Privacy Policy states: *"When you delete your account, your email, API key, and strategy settings are deleted immediately. Your personal trade history is deleted within 30 days."* No account deletion flow exists in the application. No migration, edge function, or pg_cron job implements the 30-day purge. The `trades`, `agent_memory`, and `compliance_log` tables have no TTL or archival mechanism.

**Impact:** The platform makes a binding privacy representation it cannot fulfil. Under CCPA, this is a consumer deception violation. Under GLBA (if it applies), it is a failure to honor disclosed privacy practices.

**Required fix:** Implement an account deletion endpoint (immediate PII clearance: email from auth, API keys, display name). Add a `deleted_at` timestamp to user records and a pg_cron job that purges `trades` rows where `deleted_at > 30 days`. Alternatively, remove the 30-day deletion commitment from the Privacy Policy until it is implemented.

**Severity: MEDIUM**

---

### MEDIUM — M-002: HSTS header missing

**File:** `vercel.json` — headers array

**Current state:** `vercel.json` sets `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, and a CSP. `Strict-Transport-Security` is absent. Without HSTS, an attacker on a network path can downgrade an initial HTTP request before the browser learns to use HTTPS.

**Required fix:**
```json
{ "key": "Strict-Transport-Security", "value": "max-age=31536000; includeSubDomains; preload" }
```

**Severity: MEDIUM**

---

### MEDIUM — M-003: Inconsistent risk_settings fallback between auto-trade and risk.ts

**File:** `supabase/functions/auto-trade/index.ts:196–198` · `supabase/functions/_shared/risk.ts:72`

**Current state:** Two different fallback behaviors for a missing `risk_settings` row depending on which code path is taken — `auto-trade` returns loose defaults, `risk.ts` passes all checks. Covered by H-002 above; tracked separately as a code consistency defect.

**Severity: MEDIUM** (resolved when H-002 is fixed)

---

### LOW — L-001: No `order_submitted` compliance log entry for paper trades

**File:** `supabase/functions/execute-trade/index.ts`

**Current state:** `compliance_log` was designed with `order_submitted` as a required event. Live trades log the Kalshi API submission. Paper mode inserts the trade row but does not log an `order_submitted` event before execution. The per-order `order_submitted → order_filled/order_failed` sequence is incomplete for paper trades.

**Required fix:** In `execute-trade`, insert a `compliance_log` row with `event_type: 'order_submitted'` and full order parameters before executing the paper or live trade.

**Severity: LOW**

---

### LOW — L-002: CSP allows `unsafe-inline` for scripts

**File:** `vercel.json:21`

**Current state:** Content-Security-Policy includes `script-src 'self' 'unsafe-inline'`. This weakens XSS protection — any script injection vulnerability that inserts a script tag will execute.

**Required fix:** Migrate to nonce-based CSP via Vercel Edge Middleware. As interim: test removing `'unsafe-inline'` to confirm Vite build bundles all scripts inline-free.

**Severity: LOW**

---

### LOW — L-003: `/onboarding` and `/billing` routes not auth-gated

**File:** `src/App.tsx:256–258`

**Current state:** Both routes are listed as "Auth-protected" in comments but are not wrapped in auth guards in JSX. An unauthenticated user navigating directly to `/onboarding` will reach `OnboardingPage.tsx` where `supabase.auth.getSession()` returns null, silently skipping key-save and name-save steps. `/billing` calls Stripe checkout creation against a null session token.

**Required fix:** Wrap both routes in a `ProtectedRoute` component consistent with the rest of the app.

**Severity: LOW**

---

## Part III — Positive Observations

The following areas are correctly implemented and hold up to audit:

- **AES-256-GCM encryption for Kalshi API keys** — fresh random IV per write, master key in environment variables (not DB), decrypt-only at execution time. The `save-kalshi-key` edge function reads user identity exclusively from the verified JWT, never from request body.
- **Risk controls are server-enforced** — position limits, daily loss limits, drawdown limits, and concentration limits all run in edge functions before any order is submitted to Kalshi. The kill switch (`is_halted`) pattern auto-trips after configurable consecutive failures.
- **Onboarding risk acknowledgment flow** — three explicit checkboxes in `OnboardingPage.tsx` with plain-language text covering loss risk, agent autonomy, and ToS agreement. The proceed button is disabled until all three are checked. This is substantive, not checkbox theater.
- **Multi-tenancy RLS** — migration `20260520_tighten_rls_remove_null_escape.sql` correctly removed the `user_id IS NULL OR user_id = auth.uid()` escape hatch. All user-facing tables restrict each user to exactly their own rows.
- **Terms of Service and Privacy Policy** — substantive, not boilerplate. Accurately describes fund custody model (users own their Kalshi accounts), limitation of liability, API key encryption, and community data sharing. The limitation of liability section is specific and legally competent as a first-draft document.
- **Circuit breaker on Kalshi API** — implemented via compliance_log-backed cross-run window, preventing runaway retry storms during exchange outages.
- **Prompt injection defense** — `_shared/prompt-safety.ts`, XML-wrapped context, `parseQualifyResponse` validation all in place.

---

## Part IV — Remediation Roadmap

### Immediate (must fix before any live trading or paid subscription)

| # | Finding | File | Owner | Est. Effort |
|---|---------|------|-------|-------------|
| C-001 | Auth bypass in execute-trade | `_shared/tenant.ts`, `execute-trade/index.ts` | Engineering | 1 hour |
| C-002 | Remove hardcoded performance stats / add CFTC disclaimer | `LandingPage.tsx` | Engineering | 2 hours |
| 1.1 | CTA registration — Series 3 exam + NFA Form 7-R | External | Founder | 4–8 weeks |
| 1.4 | Read Kalshi Developer Agreement — confirm SaaS model permitted | External | Founder | 1 week |
| 1.6 | NFA Disclosure Document — draft, file, get accepted | CFTC compliance attorney | Founder + Counsel | 4–6 weeks |

### Before first paying user (in addition to above)

| # | Finding | File | Owner | Est. Effort |
|---|---------|------|-------|-------------|
| H-001 | Add US-person attestation to signup | `OnboardingPage.tsx`, `TermsPage.tsx` | Engineering | 4 hours |
| H-002 | Unify risk_settings fallback — fail-safe defaults | `risk.ts`, `auto-trade/index.ts`, migration | Engineering | 3 hours |
| H-003 | Separate compliance-critical events from ops log | Migration, edge functions | Engineering | 1 day |
| M-001 | Account deletion flow + 30-day purge cron, or remove Privacy Policy commitment | Edge function, pg_cron, `PrivacyPage.tsx` | Engineering | 1 day |
| M-002 | Add HSTS header | `vercel.json` | Engineering | 15 minutes |

### Next sprint

| # | Finding | File | Owner | Est. Effort |
|---|---------|------|-------|-------------|
| H-004 | Remove browser direct write to api_keys; drop deprecated column | `OnboardingPage.tsx`, migration | Engineering | 4 hours |
| L-001 | Add order_submitted log entry for paper trades | `execute-trade/index.ts` | Engineering | 1 hour |
| L-002 | Tighten CSP — remove unsafe-inline | `vercel.json`, Edge Middleware | Engineering | 4 hours |
| L-003 | Add auth guards to /onboarding and /billing | `App.tsx` | Engineering | 1 hour |

### Before January 1, 2027

| # | Requirement | Owner |
|---|-------------|-------|
| 1.7 | Implement ADMT opt-out flow per California ADMT Rule | Engineering + Counsel |

---

## Part V — Open Legal Questions

The following questions require an attorney with CFTC/commodities law expertise to answer. They cannot be resolved by code or research alone.

1. **CTA registration timing** — Can the platform operate with users on a waitlist (no active trading) while CTA registration is pending, or does soliciting waitlist sign-ups already constitute "holding out"?

2. **GLBA applicability** — Does this platform meet the "significantly engaged in financial activities" threshold under GLBA? If so, annual privacy notices are required from the first paying user.

3. **Kalshi commercial terms** — Does the Kalshi Developer Agreement permit a commercial SaaS that sub-licenses API access to end users via a subscription model? Are there volume-based tiers or partnership requirements?

4. **NFA Disclosure Document scope** — What level of AI model description is required in the Disclosure Document? Does proprietary model description require redaction or summarization?

5. **CFTC Regulation 166.3 supervision** — What documentation is required to demonstrate "diligent supervision" of an AI trading system? Does this require formal testing logs, model validation records, or third-party review?

---

## Appendix A — Regulatory Citations

| Regulation | Citation | Summary |
|-----------|---------|---------|
| CTA Definition | 17 C.F.R. § 1.3 | Covers persons receiving compensation for directing trading in commodity interests |
| CTA Registration | CEA § 4m / 7 U.S.C. § 6m | Registration requirement for CTAs |
| CTA Exemptions | CFTC Rule 4.14 / 17 CFR § 4.14 | Conditions for exemption from CTA registration |
| Holding Out | CFTC No-Action tm97-26 | Public marketing constitutes holding out |
| Disclosure Document | 17 CFR §§ 4.34, 4.35 | Required contents and NFA review process |
| AI Supervision | CFTC Regulation 166.3 | Diligent supervision of algorithmic systems |
| Position Limits | 17 CFR Part 150 | Does not apply to prediction market event contracts |
| GLBA | 15 U.S.C. § 6801 | Privacy notices for financial institutions |
| CCPA | Cal. Civil Code § 1798.100 | California consumer privacy rights |
| ADMT Rule | Cal. Civil Code (CPRA amendment) | Automated decision-making opt-out, effective Jan 1, 2027 |
| FTC Act § 5 | 15 U.S.C. § 45 | Prohibition on deceptive practices in AI marketing |
| CFTC Enforcement Advisory | Apr 2026 | Prediction market prohibited trading categories |

---

*This document is an internal pre-audit self-assessment. It does not constitute legal advice. All regulatory conclusions should be reviewed by qualified CFTC/commodities legal counsel before acting on them. Classification: Confidential — Internal Use Only.*
