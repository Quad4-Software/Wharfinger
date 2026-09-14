---
name: security-audit
description: >
  Run the per-feature security and privacy pass required before a
  TODO item is checked off. Use after implementing any feature that
  touches auth, input, network, storage, or agents.
---

## Procedure

1. List every new endpoint, table, file read, subprocess, outbound
   request, and ws frame the feature introduces.
2. For each, answer the checklist in `rules/security.md` items 1-9.
   Write findings down; fix before shipping.
3. Mechanical scans on the diff: `@html`, `eval`, `Math.random`,
   `InsecureSkipVerify`, string-concatenated SQL, `dangerously`
   patterns, new `fetch(` outside the egress dispatcher, subprocess
   argv built from variables.
4. Race pass: find every read-then-write on shared state. Anything
   separated by an await is suspect. Prefer a single conditional
   statement or a transaction.
5. Secrets pass: trace each new secret from input to rest. It must
   be sealed or hashed before storage and must not appear in logs,
   audit detail, job status text, or API responses beyond the first
   display.
6. Privacy pass: what reaches telemetry or an AI provider? Confirm
   opt-in and the field allowlist.
7. Write a hostile test for each real finding fixed.
