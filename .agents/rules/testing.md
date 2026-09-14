# Testing rules

## Test types

- `tests/unit/*.test.ts` server-side unit tests (vitest, node env).
  Required for every module under `src/lib/server/` that contains
  logic beyond re-exports.
- `tests/unit/*.test.ts` route tests for every `admin/api` route:
  auth rejection, validation rejection, happy path, one hostile case.
- `tests/component/` DOM tests for components holding logic
  (sorting, filtering, derived state). Pure markup components are
  exempt.
- `tests/e2e/` Playwright smoke for public pages and flows that cross
  processes. Not for admin flows that need a session.
- `agent/**/*_test.go` for every Go package with logic.

`check:tests` enforces the mapping via `scripts/check-tests.mjs` and
the exemption manifest. Exemptions need a reason in the manifest.

## Coverage

`check:coverage` runs vitest coverage over `src/lib/server/**`. The
floor lives in `vitest.config.ts` coverage thresholds. Floors may
only move upward. New modules must land at or above the floor on day
one.

## What a good test looks like here

- Uses an in-memory or temp-dir `DatabaseSync`, never the dev db.
- Asserts on state and on boundary behavior, not internals.
- Includes the hostile case: bad signature, replayed token, oversized
  body, concurrent double-submit, missing permission.
- No network. Egress-dependent code is tested through an injected
  fake dispatcher or a local listener.
- Deterministic: no real timers where a fake clock works, no sleeps.

## Gates

`pnpm verify` must stay green: svelte-check, eslint, prettier,
vitest, knip, build. `check:files`, `check:tests`, `check:coverage`
run alongside. `pnpm check:tsgo` and `pnpm test:e2e` before shipping.
Go: vet, test -race, gofmt -l must be clean.
