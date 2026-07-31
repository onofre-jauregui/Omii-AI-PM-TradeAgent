# Skill Observation Log — Omii-AI-PM-TradeAgent

Status key: OPEN = not yet actioned | ACTIONED = skill updated/created | DECLINED = not pursued

---

### Observation 1: Supabase management API /secrets returns digests, not values
**Status:** OPEN
**Date:** 2026-07-31
**Session context:** Diagnosing live Kalshi 401 order rejections
**Skill:** debugging-and-error-recovery
**Type:** open-source
**Phase/Area:** Evidence gathering / external API semantics
**Issue:** The Supabase management API `GET /v1/projects/{ref}/secrets` returns a 64-char hex SHA-256 digest in the `value` field, not the secret's plaintext. The agent briefly diagnosed a "hex vs base64 key format mismatch" from that digest before recognizing the shape (64 hex chars) as a hash.
**Suggested improvement:** Add a rule: when an API-returned "value" field has the exact shape of a hash digest (32/40/64 hex chars), verify whether the endpoint masks secrets before building any theory on the value's format.
**Principle:** Secret-listing endpoints commonly return digests or masks; confirm an inspected credential is plaintext before reasoning about its encoding.

### Observation 2: String(obj) masked the root cause across every error sink
**Status:** OPEN
**Date:** 2026-07-31
**Session context:** Same 401 diagnosis — failure_reason logged as "[object Object]" in failed_trade_queue, compliance_log, and the Telegram alert
**Skill:** observability
**Type:** open-source
**Phase/Area:** Structured logging / error serialization
**Issue:** Error detail was derived via `String(rawError)` where rawError could be an object (`{code, details, message}`), so all three error sinks recorded "[object Object]" and the actual Kalshi error (`authentication_error/NOT_FOUND`) survived only in a JSONB metadata column. Diagnosis depended on that one accidental preservation.
**Suggested improvement:** Add a rule: error-detail serialization must JSON.stringify non-string values (with `?? String(v)` fallback for undefined), and at least one sink must persist the raw upstream response verbatim.
**Principle:** Every error sink that coerces to string must handle object payloads explicitly; "[object Object]" in a log is a serialization bug that blinds incident response.
