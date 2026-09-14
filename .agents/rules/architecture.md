# Architecture rules

## Layers

```
routes/            thin HTTP handlers: parse, authorize, call service, respond
lib/server/        services and stores; own all SQL and all side effects
lib/shared/        types and pure functions safe for client and server
lib/components/    Svelte components, one concern each
lib/state/         client stores (runes)
agent/             Go module: collectors, senders, executors
server/*.mjs       production entry + ws bridges (no business logic)
```

A layer may call downward only. Routes never contain SQL. Stores
never touch `RequestEvent`. Client code never imports `lib/server`.

## File size limits (enforced by check:files)

- Server modules: 800 lines
- Svelte components: 700 lines
- Route handlers: 500 lines
- Test files: exempt

A file approaching its ceiling gets split by responsibility, not by
arbitrary line cut. Use `skills/safe-breakdown/`. The exception list
in `scripts/check-files.mjs` may only shrink.

## Extensibility rules

- New check types implement the `Checker` interface and register in
  one place. No edits inside other checkers.
- New job kinds register a handler in the job runner switch. The
  queue itself never learns about payloads.
- New forge drivers implement the `Forge` interface. Webhook routes
  dispatch on driver, not on provider name strings.
- New AI providers implement the OpenAI-compatible adapter contract
  or add a named driver. No provider strings scattered in UI code.

## Data rules

- The snapshot builder is the only write path for public API payloads.
- Secrets: scrypt for passwords, sha256 for token lookup, AES-256-GCM
  `v1.` envelope for anything the server must later read.
- Resolved `${VAR}` values are never persisted.
- Every table that grows needs a prune path on the cleanup tick.
- Concurrent writes that must not race use a transaction or a single
  conditional statement. Read-check-write across an await is a bug.

## Deployment model rules

- The hub is the control plane. The agent is the executor. No SSH.
- The agent pulls jobs; the hub never pushes execution uninvited.
- Job specs are immutable snapshots. A running deploy is unaffected
  by later config edits.
- Runtime ops use fixed argv against docker or podman CLI, with
  podman preferred when both exist.
