# Changelog

## Unreleased

The post-0.1.0 feature batch: error tracking, a full panel overhaul,
agent self-update, edge observability, and a New Relic-class
observability pass.

### Added

- Push monitors: dead man's switch check-in at `/api/push/<token>`
  (per-service HMAC-derived token URL, expected interval + grace,
  never-beaten reads as degraded)
- Maintenance alert suppression: services inside an active window no
  longer fire down/degraded notifications
- SLOs: per-service `[[slos]]` target + window, error budget left and
  burn rate on the service card, editable in the panel
- Deployment markers: `markers` table, admin + `/api/v1` POST APIs,
  vertical lines on latency charts, auto-markers for new telemetry
  releases
- Traces: Sentry `transaction` envelopes now store spans in
  `telemetry_traces`/`telemetry_spans` (previously misfiled as error
  events), with a waterfall view and p50/p95/p99 per transaction
- Scoped automation keys: `qs_` bearer tokens (sha256-hashed, shown
  once) with read/write scopes for `/api/v1/status|incidents|markers`,
  managed in the panel
- Status webhook subscribers: double-opt-in `/api/subscribe` flow,
  per-service filters, HMAC-signed dispatch, signed unsubscribe links,
  subscriber list in the Notifications panel
- New check types: `postgres`, `mysql`, `redis` (raw-socket protocol
  pings), `rdap` (domain expiry via IANA bootstrap), `websocket`
  (upgrade handshake validation), `domain` (composite DNS/TLS/DANE/
  security-header/port-sweep health), `xmpp` (client stream probe),
  `irc` (NICK/USER greeting probe with PING/PONG)
- Kubernetes runtime: deploy apps can target k8s/k3s via per-app
  namespace + replicas fields; the agent renders manifests in-process,
  applies via kubectl stdin, waits on rollout status, and rolls back
  on failure (maxUnavailable 0 keeps the swap zero-gap)
- Image scanning + OWASP recommendations: agents run trivy on demand,
  findings store per scan report, and a recommendation engine flags
  unpinned images, missing healthchecks, and critical findings with
  one-click auto-fix where the app model can express the patch
- Anomaly detection: EWMA baselines over auth failures, deploy
  frequency, service flap rate, config churn, and per-agent metric
  drift; anomalies page with ack flow, alerts fan out through the
  notify dispatcher with per-metric cooldown
- Groups + teams + secret sets: named groups for services and apps
  (dashboard + status-page filter chips), teams with member rosters
  and group assignments, sealed reusable secret sets with audited
  per-key reveal; six new RBAC permissions mapped into builtins
- Agent hardening: `wharfinger-agent setup` one-shot root installer
  (distro-aware, scoped sudoers, dry-run default), ws keepalive +
  write deadlines, jittered backoff, drop-on-busy metrics coalescing,
  capped backfill, firewalld collection with published-port bypass
  detection
- Agent edge proxy (`agent/internal/edge/`): per-app reverse proxy +
  static serving with exact/wildcard host matching, HTTP->HTTPS
  redirect, ACME HTTP-01 + DNS-01 via user hook script, manual cert
  drop-in, cert inventory on metrics posts, loopback-only /edgez
  debug endpoint; route table pulls from `GET /ingress/routes` over
  the same proof-signed channel as jobs (proof covers the ?v= stamp,
  304 on unchanged)
- Deploy port mappings: explicit host:container list per app with
  range + duplicate validation; auto-derived healthcheck ports bind
  127.0.0.1 only so edge upstreams resolve without public exposure
- Tailwind v4.3 + Vite 8 feature pass: container queries on service
  cards, native scrollbar + field-sizing utilities, tabular-nums
  metrics, runed useInterval polling; build devtools available via
  VITE_DEVTOOLS=1 (off by default, it hangs the inlined SSR graph)
- Deployment platform (phase 1): `deploy_apps`/`deploy_releases`/`deploy_keys`
  tables, per-app ed25519 deploy keys (private half sealed, public
  shown once), sealed env maps, immutable release records with
  one-click rollback, GitHub/GitLab/custom-forge webhooks with HMAC
  verification and delivery dedupe, and a deploy panel (apps list,
  app detail, env editor, releases, queue view)
- Durable job queue: `jobs` table with lease-based claiming,
  heartbeat + stale-lease recovery, crash recovery to `unknown`,
  dedupe on job_key, bounded results and logs, piggybacked pending
  counts on agent metrics posts
- Agent deploy executor (`agent/internal/deploy/`): proof-signed job
  claim, git fetch with job deploy key via `GIT_SSH_COMMAND`,
  podman-first runtime (docker fallback) with fixed argv, zero-gap
  container replacement (new container must pass its healthcheck
  before the old one stops), crash journal + startup reconcile, and
  env-value redaction across streamed logs and failure tails
- Full RBAC: roles table with seeded admin/operator/viewer builtins,
  per-request permission resolution, a roles.manage API + editor,
  status.view read tier, and OIDC/LDAP/invite role validation
- Password strength meter + generator across setup, invite, account,
  and user modals
- Calendar rework: day detail view, multi-day continuity, keyboard
  navigation
- Agent Reticulum collector: detects reticulum-go or Python rnsd,
  prefers the localhost Control API and falls back to status CLI
  output; reports flavor, transport identity, interfaces, paths, and
  rgoslow findings
- New notifiers: slack, discord, teams, telegram, gotify, pushover
- JSON config backup: `admin/api/backup` export/import of exportable
  sections with merge or replace modes; auth sections never import

- Error tracking (Bugsink/GlitchTip-style): Sentry-protocol ingest at
  `/api/<project>/envelope/` and `/api/<project>/store/`, per-project
  DSN keys, issue grouping, retention caps, and a panel UI
- Hub-hosted agent releases: upload binaries in the Systems panel,
  agents update from `/api/agent-release/manifest` via
  `UPDATE_MANIFEST` for air-gapped fleets
- Agent self-update: sha256-verified atomic install, optional periodic
  mode (`SELF_UPDATE=1`), install.sh `--self-update` flag
- Prometheus `/metrics`: service status, uptime ratios, latency, cert
  expiry, incident and maintenance counts
- New check types: `json` (HTTP + JSON path assertion) and `a2s`
  (Source Engine/Steam UDP query)
- New agent collectors: podman (rootful + rootless), Kubernetes
  (kubelet), CrowdSec (cscli), Traefik API detection
- Edge observability: `plugins/traefikedge` middleware reports status
  classes, latency percentiles, top clients/paths, and 5xx samples to
  `/ingress/edge`
- Panel: customizable dashboard widgets (reorder/hide/span, per-user
  persistence), reusable sortable/searchable DataTable, maintenance
  calendar, audit search/CSV export, badge builder with live preview,
  draft page preview, richer activity feed, sticky settings nav with
  save-all
- Accounts: avatar upload (magic-byte validated, moderated), session
  browser/OS labels, TOTP QR setup, sign-out-others
- `frame-ancestors` site config for controlled embeds
- OIDC e2e coverage against a mock provider; LDAP unit coverage via a
  stubbed client
- Passkeys: WebAuthn registration and sign-in (discoverable and
  per-account ceremonies, counter-rollback rejects cloned
  authenticators, passkey replaces the password factor while TOTP
  stays required), managed on the account page with `[admin]
webauthn_origin`/`webauthn_rp_id` overrides
- Agent proof of possession: agents generate an ed25519 identity key
  on first run, bind it to their registration, and sign the hello
  nonce and every metrics frame; a stolen bearer token alone can no
  longer post data
- Hub key rotation: `POST /admin/api/agents/rotate-hub-key` rekeys the
  hub and publishes a continuity proof (old key signs new pubkey);
  pinned agents verify the proof and re-pin automatically
- Encrypted config backups: passphrase-protected scrypt+AES-GCM
  export envelopes, auto-detected on import, plaintext export kept
  with a visible warning
- Audit log integrity: sha256 hash chain over every audit row,
  backfilled at startup, `GET /admin/api/audit/verify` plus a panel
  verify button reports the first broken row
- Admin per-user sessions: `users.manage` can list and revoke any
  user's sessions from the users page
- Agent operational hardening: `-state-dir`, `-strict-perms` warns or
  refuses on group/world-readable token/key/state files, kubelet
  collection fails closed without `WHARFINGER_KUBE_CA_FILE` unless
  `-kube-insecure` is set
- Ops chat: rooms and DMs for panel users over a loopback-authed
  WebSocket bridge (`<admin>/chat/ws`), presence rings on avatar
  cascades, typing indicators, unread badges, toasts, REST history and
  polling fallback; message bodies are sealed at rest with AES-GCM and
  rendered as text only
- SSH and login monitoring: agent reports `who` sessions, accepted and
  failed login events with method and source IP, and top offenders;
  journalctl first with auth.log/secure fallback, degrades to a
  partial state when logs are unreadable, shown in a Logins card on
  the agent page
- Audit page rework: KPI strip (today/week/actors/failed auth),
  day-grouped timeline with kind-colored action pills, actor and
  search filters as removable chips, CSV export under filters, and a
  chain-integrity verify action
- Skeleton loading and shaped empty states across the panel and status
  pages; Escape closes the mobile nav drawer
- Static site deploys: `static` source apps clone the repo, run the
  build, and publish the output dir through the agent edge proxy via
  an atomic versioned-symlink swap; serving falls back to index.html,
  emits weak ETags + 304s, and marks hashed assets immutable
  (audit: paths stay under the app state root, traversal rejected,
  no secrets in the static spec)
- Compose import: `POST /admin/api/deploy/apps/compose` converts a
  compose file into linked apps under a shared group; the panel gets
  an Import compose modal with a preview plan that lists unsupported
  keys and dropped semantics loudly instead of silently discarding
  them (audit: deploy.manage-gated, 256KB body cap, env sealed via
  setEnv, all-or-nothing create with rollback cleanup)
- Smart domain config: `GET /admin/api/deploy/apps/[id]/domain-check`
  runs a DNS preflight per app domain and a Check DNS panel button
  renders it: resolved A/AAAA answers compared against the
  agent-reported interface addresses (new `net.addresses` in the
  signed payload), wildcard probing via an unlikely label, private-only
  answer warnings for ACME reachability, CNAME chain display, and
  conflict warnings when another app claims the same host or a
  covering wildcard. Duplicate exact hosts now route to the lowest
  app id deterministically (audit: deploy.view-gated read, bounded
  DNS-only lookups through the system resolver, no outbound connect to
  resolved IPs)
- Edge WAF posture: the agent proxy now supports ravenguard-style
  policy via -edge-block-ips/-edge-allow-ips/-edge-block-ua list files
  (one entry per line, reloaded on every route sync) and a
  per-client-IP rate limit (-edge-rate/-edge-rate-burst). Denied IPs
  and UA substrings get 403, over-limit clients get 429 + Retry-After,
  allowlisted IPs skip only the limiter, and the client IP is always
  the socket peer. An 8KB request-target cap joins the existing body
  and header caps; /edgez reports the loaded policy counts (audit:
  ACME challenge path exempt, no regex in list parsing, limiter map
  capped and swept)
- Firewall bypass repair: the agent now reports which published
  container ports bypass ufw (joining the existing firewalld
  bypassed list, shown on the agent page), and the new opt-in
  `wharfinger-agent firewall` subcommand prints a plan then, with
  -yes as root, inserts tagged DOCKER-USER rules: private sources
  return early, external traffic jumps into ufw-user-forward so
  `ufw route allow` governs again, and new forwards toward private
  space drop. -revert removes every wharfinger-fwfix rule
- Pluggable storage: the hub store layer now sits behind an async
  `Db` driver interface. SQLite over node:sqlite stays the default
  and is unchanged; `[storage] driver = "surreal"` with url/ns/db/
  user/pass connects to SurrealDB over websocket JSON-RPC for fleets
  that outgrow a single file. SQLite-flavored SQL is translated to
  SurrealQL at prepare() time, non-portable queries (joins, window
  functions, dynamic LIKE) are hand-ported per backend, and write
  transactions serialize through db.tx(). The runtime exposes a
  ready promise so getRuntime() stays synchronous; hooks await it
  before serving. Design notes and the supported SQL subset live in
  .agents/references/storage.md
- Forge integration: per-app forge kind (github, gitlab, gitea/
  forgejo, generic) with a sealed PAT/app token, commit-status posts
  on pending/live/failed/rolled_back, monorepo path-filter globs on
  push webhooks, opt-in submodule and LFS clones, and branch browsing
  in the app form via a server-side list endpoint routed through the
  egress guard
- PR/MR preview deployments: opt-in per app (source.previews), a
  pull_request or Merge Request Hook event creates an ephemeral app
  (<parent>-pr<N>) cloned from the parent with the PR head ref, an
  allocated loopback port, and a 72h TTL. Synchronize pushes redeploy
  the same preview; close/merge events and the runtime sweep enqueue
  a durable teardown job, and the agent removes the app's containers,
  images, k8s resources, and checkout dirs. The panel shows a PR chip
  in the app list and a preview banner with the expiry on the detail
  page (audit: previews carry the parent's secrets so the opt-in is
  explicit; previews cannot spawn previews; forge responses are
  bounded and unhandled PR actions no longer reach the push path)
- Host lifecycle tasks: POST /admin/api/agents/<id>/task enqueues a
  signed agent-task job (service.start/stop/restart, packages.refresh,
  packages.apply with a securityOnly flag, host.reboot). jobs.not_before
  schedules tasks up to 7 days out, and a reboot sets agents.muted_until
  so the expected offline gap does not page. The agent revalidates the
  spec, builds fixed argv through the resolved-binary runner (systemd
  and OpenRC for services; apt/dnf/apk/pacman/zypper for packages), and
  closes the job before signalling pid1 to reboot
- Package posture collector: the agent reports pending/security update
  counts and the distro reboot-required flag (cached ~30min so index
  queries never run per sample); the fleet list chips hosts with
  pending security updates or a required reboot and ranks them toward
  the top
- AI assistant (opt-in): `[ai]` section wires an OpenAI-compatible
  provider (Ollama/LM Studio/llama.cpp/OpenAI, `/chat/completions`
  appended to a versioned base url); the incidents page gains an
  assistant card that asks questions against a bounded, sanitized
  snapshot context and proposes actions from a fixed kind catalog
  that resolve to real audited admin routes behind a confirm click.
  Provider calls go through the egress dispatcher with a bounded
  response and per-user rate limits; `ai.use` is a new permission and
  asks/suggestions are audit-logged
- MCP endpoint: `POST /api/mcp` serves five pinned read-only tools
  (list_services, get_service, list_incidents, list_agents,
  list_jobs) over JSON-RPC to `read`-scoped qs_ keys, gated on
  `[ai].mcp_enabled`; tool output is sanitized and capped at 32 KiB

### Fixed

- Deploy app edits (env, domains, runtime fields) now carry an
  optimistic-concurrency stamp: a stale writer gets a 409 instead of
  silently clobbering a concurrent edit, and the panel reloads on
  conflict
- Route-table version is now a content hash of the routes, not a
  timestamp: a domain edit landing in the same millisecond as a
  release transition could previously leave agents with a stale table
  because the version never moved

- Snapshot rebuilds reuse fetched check rows for uptime windows covered
  by history, cutting redundant per-service SQL on every check
- MetricChart recomputed every series path per hover frame; paths now
  derive once with single-pass bounds and binary-search hover, and the
  agent detail page stops polling while the tab is hidden
- Admin login over plain http: adapter-node reported https
  unconditionally, so session cookies were Secure and never sent;
  server.js now stamps the real socket/forwarded protocol
- Agent IDOR: operator role could read/manage agent payloads; agent
  routes now require `agents.manage`
- SSRF hardening: egress guard with connect-time DNS validation for
  monitor checks and notification sends
- ws ingest fingerprint race and edge-report replay dedup
- Telemetry deep scrubbing covers request URLs, headers, and cookies
  before raw event storage
- Dead `status-*` utility classes replaced with the theme's real
  `--color-up/down/degraded/maint` tokens
- Toast text glow removed; podman socket dedup; traefikedge module
  path fixed for yaegi resolution

### Security

- Session invalidation on role change/disable/delete verified
- Rate-limit and audit client IPs honor X-Forwarded-For only with
  `WHARFINGER_TRUST_PROXY`
- Agent subprocess binaries resolve from root-owned absolute paths
- frame-ancestors cannot widen to `*`
- Updater: sha256 pin, atomic rename, single-flight lock, restart via
  supervisor
- Icon fetcher routed through the egress guard: monitored pages can no
  longer point link icons at link-local or metadata targets and have
  the response republished at `/favicon/<id>`
- Raw TOML editor now filters reads and rejects writes to sections the
  actor lacks permission for, closing a `config.raw` privilege bypass
- Role grants require the actor to hold every permission in the role,
  so `users.manage`/`invites.manage` can no longer mint admins
- `${VAR}` interpolation applies to the config file only; panel
  overrides and dry-run service bodies keep placeholders literal
- Invite/reset redemption and first-admin setup are single-statement
  conditional writes, closing the concurrent-redemption and
  duplicate-admin races
- OIDC discovery/token/userinfo and LDAP connect targets run through
  the egress guard; `X-Forwarded-Proto` honored only with
  `WHARFINGER_TRUST_PROXY`
- Hub ed25519 private key sealed at rest with lazy migration; data dir
  0700 and `wharfinger.db` 0600 on open
- Login lockout reworked: per-IP lockout plus a per-username
  progressive delay, so distributed failures no longer lock a real
  user out from a new address
- Admin mutations reject cross-origin requests via Origin and
  Sec-Fetch-Site; the ws bridge gets its own handshake limiter and
  loopback forwards no longer share the public ingress bucket
- Password reset links revoke existing sessions at generation; OIDC
  group sync can no longer demote the last enabled admin
- Overview endpoint gates override metadata and the delivery log;
  subscribe bodies are bounded; avatar uploads check declared length
  before buffering
- Audit CSV escapes formula-leading cells; NAT64-embedded link-local
  addresses are blocked; invite hash prefixes need 8+ chars; ws token
  moved out of `x-token`; telemetry is opt-in by default

## 0.1.0

Initial release: status pages with incident history rail, monitors
(http/tcp/dns/ping/cert), named pages, RSS/badges/JSON API, admin
panel with OIDC/LDAP/TOTP, Go agent over WebSocket+REST ingress,
Docker and release workflows.
