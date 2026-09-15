# Agent notes

Read `.agents/` first: `rules/` are binding (style, architecture,
security, testing), `skills/` are procedures to follow (job-queue,
deploy-pipeline, safe-breakdown, security-audit, ui-standards), and
`references/` hold design notes. TODO.md tracks planned work.

## Commands

- `pnpm dev` dev server (starts the monitor against config/wharfinger.toml)
- `pnpm verify` full gate: svelte-check, eslint, prettier check, vitest, knip, vite build
- `pnpm test` unit + component tests (vitest projects: server/node + component/jsdom)
- `pnpm test:e2e` playwright smoke (needs `pnpm exec playwright install` once)
- `pnpm check:tsgo` fast native typecheck (typescript 7 sidecar; JS `check` is authoritative)
- `pnpm check:files` no-god-files gate (line ceilings per file type)
- `pnpm check:tests` test-type consistency gate
- `pnpm check:coverage` coverage floor for server modules

## Structure

- `src/lib/server/` config (TOML+valibot), monitor (checkers, scheduler, flap protection), store (async `Db` driver: node:sqlite default, SurrealDB optional via `[storage]`; see .agents/references/storage.md), status (snapshot builder), sse, http helpers
- `src/lib/server/admin/` authn/z (scrypt, TOTP, sessions, invites, lockout, audit), config section actions, http helpers
- `src/lib/server/config/` schema + load (TOML base) + store/effective (sqlite section overrides merged over the file)
- `src/lib/server/notify/` dispatcher + senders (ntfy, unifiedpush, webhook) + delivery log
- `src/lib/server/ingress/` agent ingest: valibot schema, token auth + fingerprint binding (agents.ts), ed25519 hub keys, shared view; routes under `src/routes/ingress/`; alerts.ts evaluates [ingress].alert_* rules into notify events (offline via 60s tick, thresholds on ingest, state persisted on the agents row); edge.ts stores traefik-plugin traffic reports (`POST /ingress/edge`, deduped on (agent_id, ts))
- `src/lib/server/admin/auth/oidc.ts` + `ldap.ts` external identity (Pocket ID default issuer auth.quad4.io); external.ts provisions `source = oidc|ldap` users
- `server.js` + `server/ingress-ws.mjs` production entry: adapter-node plus a WS bridge that forwards `/ingress/ws` traffic to the same REST ingress logic
- `agent/` standalone Go module (wharfinger-agent): /proc + /sys collectors, ws-primary sender with REST fallback; `WHARFINGER_PROC_ROOT`/`WHARFINGER_SYS_ROOT` relocate roots for containers; docker.go covers docker + podman sockets, k8s.go the local kubelet, crowdsec.go `cscli`, traefik.go `--api`, logins.go login/ssh activity (`who` sessions plus sshd events from journalctl or auth.log/secure, `partial`+`note` when no log source is readable); `firewall` subcommand repairs the docker-bypasses-ufw gap with tagged DOCKER-USER rules (plan by default, -yes as root, -revert)
- `plugins/traefikedge/` yaegi-compatible Traefik middleware (stdlib only) that aggregates request telemetry to `/ingress/edge`
- `src/lib/server/telemetry.ts` Sentry-protocol error reporter (Sentry/GlitchTip/Bugsink via `[telemetry].dsn`); browser crashes relay through `POST /api/telemetry`
- `src/lib/server/telemetry/` local error tracking: `store.ts` (projects/issues/events tables, caps) + `ingest.ts` (envelope parse, deep scrub, fingerprinting); public ingest at `/api/<projectId>/envelope|store`, admin API under `admin/api/telemetry/`
- `src/lib/server/agent-release.ts` hub-hosted agent binaries for air-gapped self-update; files on disk under `<data>/agent-releases/`, manifest at `/api/agent-release/manifest`, upload/delete via `admin/api/agent-release` (agents.manage)
- `src/lib/server/ai/` opt-in assistant: provider.ts (OpenAI-compatible adapter through the egress dispatcher), context.ts (sanitized quoted-as-data prompt builder), suggest.ts (fixed action catalog resolving to audited routes, never auto-executed), mcp.ts (pinned read-only tools behind `read`-scoped qs_ keys at `POST /api/mcp`, gated on `[ai].mcp_enabled`); design notes in `.agents/references/ai-mcp.md`
- `src/routes/metrics/` Prometheus text exposition built from the cached public snapshot
- `src/lib/server/store/` per-feature tables: checks, push beats (`push.ts`), deployment markers (`markers.ts`), scoped automation keys (`apikeys.ts`), status webhook subscribers (`subscribers.ts`)
- check types beyond http/tcp/dns/ping: json, a2s, postgres, mysql, redis, rdap (domain expiry), websocket upgrade, push (dead man's switch via `/api/push/<token>`; tokens derive from the hub key per service)
- `src/lib/server/apikey.ts` Bearer auth for `/api/v1/*` (status, incidents, markers) with read/write scopes; managed at `admin/api/keys`
- subscribers: public double-opt-in webhook subscriptions (`/api/subscribe`, confirm/unsub links); dispatcher fans transitions out HMAC-signed through the egress guard
- `admin/api/backup` exports/imports exportable config sections as JSON (merge or replace; auth sections never import); `full` adds the durable tables (deploy, sealed secrets, hub keys, agents, api keys) which restore only under the same WHARFINGER_SECRET_KEY
- `server.js` stamps `x-wharfinger-proto` per request (socket proto or X-Forwarded-Proto) and `server/bootstrap-env.mjs` points PROTOCOL_HEADER at it; without it adapter-node reports https unconditionally on plain-http installs
- error surfaces: `src/routes/+error.svelte` (all statuses), `src/error.html` (fatal fallback), `CrashBoundary.svelte` in the root layout (recovery + copy debug)
- `src/lib/shared/` types + pure math used by both sides (auth roles, drafts, maintenance, notify events)
- `src/lib/components/` one component per concern, no god files; `admin/` holds panel primitives
- `src/lib/state/status-stream.svelte.ts` client SSE+poll store; `admin.svelte.ts` panel api/toast helpers
- `src/routes/admin/` panel UI + JSON API under `admin/api/`; mounts at admin.base_path via reroute in hooks.server.ts
- `config/wharfinger.toml` all runtime config; SIGHUP reloads it; admin edits persist as sqlite section overrides
- `docker/` Dockerfile (pinned digest, rootless, multi-stage) + compose + ravenguard WAF edge (ravenguard.toml, ravenguard.coolify.toml, seccomp, blocklists/allowlists)

## Conventions

- pnpm-workspace.yaml enforces minimumReleaseAge=7d and blocks install
  scripts; prefer dependency versions published at least a week ago
- typescript stays on 6.x for svelte-check/typescript-eslint; tsgo is a sidecar
- `--breakpoint-rail` (72rem) in app.css drives the two-column public
  layout: past incidents pin as a sticky aside above it, stack below
- animation utilities come from `--animate-*` tokens in app.css; toasts
  use Svelte transitions plus a toast-progress keyframe countdown
- The snapshot builder is the only write path for API payloads; keep it cached
- server-only modules must never be imported by client code; shared
  types/constants live under src/lib/shared/
- stored secrets: scrypt passwords, sha256 token hashes, AES-GCM sealed
  TOTP secrets; never persist resolved ${VAR} values
- outbound fetches (monitor checks, notify sends) must go through
  rt.egress: it blocks link-local/metadata targets and validates DNS at
  connect time; monitor.allow_link_local is the opt-out
- semantic colors in app.css are `--color-up/down/degraded/maint/...`,
  so tailwind classes are `text-up`, `bg-down` etc; there is no
  `status-` prefix
- forwarded headers (XFF, X-Real-IP) are only trusted with
  WHARFINGER_TRUST_PROXY=1; rate-limit keys and audit IPs otherwise use the
  socket address
- admin section edits validate the fully merged config and use
  updatedAt optimistic concurrency
- agent tokens are bearer secrets stored as sha256 hashes, shown once
  on register/rotate; the first nonempty machine fingerprint binds to
  the agent row atomically (UPDATE ... WHERE fingerprint IS NULL) and
  later mismatches are rejected. The same TOFU pattern binds
  agents.pubkey: the agent's ed25519 identity key must prove itself
  (hello proof over the per-connection bind_nonce, then a signature
  over every metrics body via x-agent-pubkey/x-agent-proof) before
  frames count; null pubkey marks a legacy client. Token rotation
  clears fingerprint, pubkey, and bind_nonce
- the hub ed25519 signing key rotates via
  POST /admin/api/agents/rotate-hub-key: the old key signs the new raw
  pubkey into hub_keys.proof so pinned agents can adopt it; push
  tokens derive from the separate stable hub_keys.secret, so they
  survive rotation
- the ws bridge never forwards metrics before the challenge + hello
  handshake succeeds; /ingress is ip-rate-limited before any db work
  and bodies are size-capped while streaming. Signed metrics frames
  carry the payload as a JSON string so the bridge can forward the
  exact bytes the proof covers
- sqlite writes assume concurrent connections; openDb sets
  busy_timeout and multi-statement writes go through db.tx (BEGIN
  IMMEDIATE on sqlite, interactive txn on surreal). Stores never see
  DatabaseSync; statements stay in the portable subset in
  .agents/references/storage.md
