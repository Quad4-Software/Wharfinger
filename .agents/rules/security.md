# Security rules

## Binding invariants

- Every admin mutation requires a session plus the matching
  permission, an Origin/Sec-Fetch-Site check, and an audit entry.
- Every agent-facing endpoint authenticates by hashed bearer token
  plus ed25519 proof of possession where bound.
- All outbound fetches (checks, icons, OIDC, webhooks, AI) go through
  the egress dispatcher. No raw `fetch` to user-controlled URLs.
- Webhook signatures verified in constant time before parsing.
- Input is validated at the boundary with valibot or explicit type
  checks. Bounded strings, bounded arrays, bounded bodies.
- Secrets never appear in logs, audit detail strings, job payloads
  shown to the panel, or AI prompts.
- Chat and user text render as text. `@html` is forbidden.
- Rate limits on every unauthenticated endpoint and every ws upgrade.

## Per-feature audit checklist

Run before any feature box in TODO.md is checked. Answer each item in
the PR or commit body when non-trivial.

1. Auth: which permission or token gates this? Is the check on the
   server, not the UI?
2. Input: is every field validated and bounded? Can a malformed or
   hostile payload reach a parser, a path, a query, or a shell?
3. Output: can a secret, token, sealed value, or another user's data
   leak through this response, log, or error message?
4. Concurrency: is there a read-check-write across an await, a
   double-submit path, or a TOCTOU between validate and apply?
5. SSRF: does any URL come from input or stored config? Is it through
   the egress guard including DNS validation?
6. Storage: is new secret material sealed? Is new personal data
   retention-bounded?
7. Abuse: what does this cost an attacker per call? Is it rate
   limited or authenticated?
8. Privacy: does telemetry or AI see this data? Is it opt-in and
   field-allowlisted?
9. Tests: is there a test for the hostile case, not just the happy
   path?

## AI-specific rules

- AI features are off unless `[ai].enabled` is set.
- Provider calls use the egress dispatcher and a sealed key.
- Prompt assembly uses a field allowlist. Never interpolate sealed
  values, session data, chat bodies, or raw monitored page content.
- AI output is advisory text only. Mutations require a separate,
  authenticated, audited user action.
- MCP tools are read-only by default, token-scoped, output-bounded,
  and the tool list is static per build.
