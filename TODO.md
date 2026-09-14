# Roadmap / task tracker

Wharfinger is now an ops platform: monitoring, status pages, error
tracking, chat, and deployments. This file is the master tracker.
Completed work lives in CHANGELOG.md; only open and in-flight work
belongs here.

Execution order inside each phase is roughly top-down. Every feature
lands with tests and a security/privacy audit note before its box is
checked.

## Phase 0: Platform foundations (in progress)

- [x] Durable job queue: `jobs` table, lease-based claiming,
      heartbeat + stale-lease recovery, idempotent results; survives
      hub restarts and power loss (SQLite WAL, no broker dependency)
- [x] Agent work channel: agents pull queued jobs via authenticated
      REST claim endpoints; pending count piggybacks on metrics
      posts; pull model means no inbound SSH and works behind NAT
- [x] Gates: no-god-files lint (`check:files`), test-type
      consistency (`check:tests`), coverage runner (`check:coverage`,
      numeric floor ratchet pending), wired into `pnpm verify`
- [x] `.agents/` codebase docs: rules, skills, references (see below)

## Phase 1: Deployments core (Coolify parity, simpler)

Control plane = hub. Executor = agent over the existing signed
channel. No SSH anywhere; the agent already proves possession.

- [x] `deploy_apps`: name, source (git url + ref | image ref |
      compose | static dir), target agent, runtime (podman default,
      docker opt-in), env (sealed), domain bindings, healthcheck
- [x] `deploy_keys`: per-app ed25519 deploy keypair, private half
      sealed at rest, public half shown once for forge registration;
      read-only repo access by design
- [x] `deploy_releases`: immutable release record per app (frozen
      spec, image ref, commit sha, status, timestamps) enabling
      one-click rollback to any prior release
- [x] `deploy_jobs` ride on the Phase 0 queue: spec snapshot baked
      into the job so mid-flight config edits cannot change a running
      deploy (TOCTOU-safe); maxAttempts 1 + 'unknown' on stale lease
- [x] Agent executor `agent/internal/deploy/`: git fetch via system
      git + `GIT_SSH_COMMAND` with the job's deploy key (fetched via
      the secrets endpoint, openssh-encoded, deleted after use),
      dockerfile/image builds, runtime ops via podman-or-docker CLI
      with fixed argv; compose convert pending
- [x] Zero-gap replacement: start new container, wait for
      healthcheck green, drain, then stop old; on healthcheck failure
      the old container never stops (core improvement over Coolify's
      stop-start gap)
- [x] Auto-rollback: failed healthcheck or crash-loop inside a
      bounded window preserves the previous release and marks the job
      `rolled_back`; crash journal feeds startup reconcile.
      Notification on rollback pending
- [x] Build streaming: agent posts bounded log chunks to the hub
      (env values redacted); panel shows the job log on the app page
- [x] Deploy webhooks: `POST /api/deploy/hook/<token>` per app,
      HMAC-verified (GitHub `X-Hub-Signature-256`, GitLab
      `X-Gitlab-Token`, generic secret for custom forges), branch
      filter, dedupe on delivery id
- [x] Panel: apps list, app detail (releases, logs, domains, env
      editor), deploy/rollback buttons, live job status, webhook URL
      copy
- [x] Static site path: build artifacts served through the proxy
      layer with correct cache headers and immutable-hashed asset
      rules
- [x] Docker-compose converter: ingest a compose file, emit our app
      spec (services -> linked apps or a multi-container app),
      flag unsupported keys instead of silently dropping them
- [x] Manual env/domain editing only through validated panel/API
      paths; no hand-editing of generated proxy config

## Phase 1b: Runtimes, security scanning, org structure

- [x] Kubernetes runtime: deploy executor targets k8s/k3s via
      kubectl apply (Deployment + Service + zero-gap rolling update),
      kubeconfig discovery (KUBECONFIG, ~/.kube/config, in-cluster),
      namespace + replicas per app, rollback via kubectl rollout
      undo; agent advertises `k8s` capability
- [x] Agent setup mode: `wharfinger-agent setup` one-shot root command
      that detects the distro, installs podman/docker/kubectl/trivy,
      creates the service user + kubeconfig path, and writes a
      scoped sudoers rule for the few verbs that need elevation.
      The daemon itself stays unprivileged (rootless podman is the
      default); setup is explicit and auditable, never silent
- [x] Agent connection efficiency: ws ping/pong keepalive with idle
      reaper + write deadlines, jittered exponential backoff,
      drop-on-busy metrics coalescing, capped backfill flush
- [x] firewalld collector: detect firewalld zones and
      docker-published port bypass. Opt-in fix command still pending
      (same pattern as ufw)
- [x] Image scanning: trivy `scan` job kind claimed by the agent on
      demand; JSON findings stored per report; severity summary +
      findings table on the app page
- [x] OWASP posture engine: per-app recommendations derived from
      spec + scan findings (unpinned image, missing healthcheck,
      exposed ports, critical findings), auto-fix button where the
      app model can express the patch
- [x] Service groups: named groups for services and deploy apps,
      group filter chips on the status page and panel
- [x] Teams: named teams with member users, team -> group
      assignments (scoping enforcement deferred to display layer)
- [x] RBAC expansion: scan.view/manage, anomaly.view,
      groups.manage, teams.manage, secrets.manage added and mapped
      into builtin roles with a legacy-upgrade path
- [x] Per-service secrets: named sealed secret sets with audited
      per-key reveal; resolveSecret helper exported for env and
      check-header consumers (interpolation wiring deferred)
- [x] Anomaly detection: EWMA baseline engine over auth failure
      rates, agent metric drift, deploy frequency, service flap
      rate, config churn; anomalies feed notify + a panel page

## Phase 2: Edge proxy and domains

- [x] Agent-side lightweight reverse proxy (Go, in the agent binary):
      terminates routes for deployed apps, HTTP->HTTPS redirect,
      per-route upstream, wildcard + exact host matching
- [x] Route table synced from hub over the signed channel; agents
      apply atomically via versioned poll + poke on deploy
      completion. Drift reporting beyond cert inventory still open
- [x] TLS: ACME (Let's Encrypt) via the agent for managed domains,
      HTTP-01 + DNS-01 (user-supplied hook script), plus manual cert
      drop-in; cert state reported back as inventory and shown on
      the agent page
- [x] Smart domain config: DNS preflight per app domain
      (resolve-vs-agent-address, wildcard probe, private-answer and
      ACME warnings), suggested records, conflict warnings when two
      apps claim one host; duplicates resolve to the lowest app id
- [x] WAF posture: agent proxy carries the applicable ravenguard
      blocks: IP/UA blocklists and IP allowlists (file-backed, hot
      reload on route sync), per-client-IP token-bucket rate limit,
      8KB URL cap on top of the existing body/header caps. Detect/
      challenge and process seccomp intentionally not ported (no
      telemetry collected; a process-wide filter would break the
      agent's docker/kubectl control)
- [ ] UFW integration: agent detects docker/podman publishing ports
      that bypass ufw (the classic docker-iptables problem) and can
      apply/fix rules with an explicit opt-in command. Detection
      shipped for ufw and firewalld; fix command still pending
- [x] Static file serving mode on the proxy for artifact deploys
      (safe path join, index fallback, weak ETag + 304, immutable
      hashed-asset caching)
- [x] Port mappings: explicit host:container list per app with
      duplicate-host-port rejection; auto-derived healthcheck port
      publishes bound to 127.0.0.1 so edge upstreams stay local

## Phase 3: Git forges and keys

- [ ] Forge abstraction: `forge` interface (clone url, webhook
      verify, commit status post, repo browse); drivers for github,
      gitlab, gitea/forgejo, generic git+webhook
- [ ] PAT/app-token auth for API calls (sealed), deploy keys for
      clone; never store OAuth refresh tokens unless needed
- [ ] Commit status checks posted back to the forge (pending /
      success / failure / rolled back)
- [ ] PR/MR preview deployments: ephemeral app instances per pull
      request, auto-teardown on merge/close with TTL cap
- [ ] Monorepo path filters: deploy only when touched paths match
- [ ] Shallow + partial clone defaults; submodule and LFS opt-in

## Phase 4: Server lifecycle

- [ ] Agent-driven host patching: package-manager update dry-run,
      report pending security updates, scheduled apply windows
- [ ] Reboot scheduling: drain -> reboot -> verify -> report, with
      maintenance-window integration so monitors stay quiet
- [ ] Service manager actions: restart/stop/start for systemd +
      OpenRC units from the panel (already inventoried; add control
      verbs with audit + confirm)
- [ ] Fleet view: pending updates, reboot-needed flags, agent
      versions, drift

## Phase 5: AI and MCP (opt-in, default off)

Threat model first: every AI feature is off by default, provider
calls go through the egress guard, no secrets or raw message bodies
in prompts, and nothing the model says can mutate state without a
user-confirmed action path.

- [ ] `[ai]` config section: provider preset (openai-compatible base
      url covers OpenAI/Anthropic-proxy/Ollama/LM Studio/llama.cpp),
      sealed api key, model, max tokens, temperature floor
- [ ] Provider adapter: OpenAI chat-completions wire format only;
      other formats behind explicit drivers added later
- [ ] Panel assistant: incident summarization, check failure
      explanation, config Q&A against loaded docs context; responses
      labeled as generated, sources cited
- [ ] Suggested actions, never automatic: AI can propose (restart
      service, silence window, rollback) but execution requires an
      authenticated user click with audit entry
- [ ] MCP server (separate opt-in listener or stdio binary):
      read-only tools first (list services, get status, list
      incidents, agent inventory); OAuth 2.1 or scoped `qs_` tokens;
      tool output bounded and sanitized; tool list pinned (no dynamic
      mutation) to blunt rug-pull attacks
- [ ] Prompt-injection hygiene: strip/quote monitored content fed to
      the model, fixed system prompt, no tool descriptions sourced
      from remote content
- [ ] Local-model path documented: Ollama on the same host, no
      egress needed, fully offline AI features

## Phase 6: HA and resilience

- [ ] Queue durability audit: every job transition transactional,
      lease recovery on startup, orphan requeue, exactly-once
      semantics via idempotent execution keys
- [ ] Agent executor resumes in-flight deploys after agent restart
      (state dir journal); reports unknown-outcome jobs so the hub
      can reconcile
- [ ] Hub restart mid-deploy: running jobs marked
      `unknown`/`reconciling` until the agent reports; no blind
      requeue that could double-deploy
- [ ] Multi-hub readiness: job claiming already lease-based; document
      active/passive hub pattern (single-writer SQLite constraint)
- [ ] Backup/restore covers deploy tables + sealed keys; restore
      drills documented
- [ ] Graceful degradation: deploys pause when agent offline; queue
      shows waiting jobs with reason

## Phase 7: Gates and quality infrastructure

- [ ] `pnpm check:files` no-god-files gate: line ceilings per file
      type (component 700, server module 800, route 500), explicit
      exception list that must shrink, fails the build on violation
- [ ] Split `checkers.ts` (1294 lines) into per-checker files using
      the safe-breakdown method in `.agents/skills/`
- [ ] `pnpm check:coverage` vitest coverage floor on server modules
      (start at current level, ratchet upward only)
- [ ] `pnpm check:tests` test-type consistency: every
      `src/lib/server/**` module ships a unit test, every admin API
      route ships a route test, components with logic ship a
      component test; manifest-driven with justified exemptions
- [ ] CI runs all gates on PRs; gate failures block merge
- [ ] Per-feature audit checklist in `.agents/rules/security.md`
      executed and noted before a feature box is checked

## Research notes (decisions already made)

- No Valkey/RabbitMQ: the job queue is a SQLite table. The hub is
  single-writer anyway; a broker adds failure modes and a second
  secret-bearing service without buying throughput we need.
- No SSH control path: agents pull work over the existing
  proof-of-possession channel. This is stricter than Coolify's SSH
  model and works behind NAT.
- Podman is the default runtime where both exist (rootless by
  default); docker stays supported.
- Proxy lives in the agent (Go), not the hub: traffic never
  hairpins through the control plane, matching Coolify's
  control-path/data-path split.

## Deferred / backlog

- Blue-green across two agents (same-app replicas on different hosts)
- Kubernetes as a deploy target (agent has kubelet inventory already)
- Build cache/registry push for image reuse across agents
- Canary/percentage rollouts (needs traffic-splitting proxy support)
- Scheduled deployments + deploy freezes
- GitOps mode: repo-held app specs reconciled continuously
- Multi-user chat channels per deployment (thread per release)
- Per-app resource limits + cost/usage reporting
- Template catalog (one-click apps) with pinned digests
- OIDC workload identity for cloud pulls instead of long-lived keys

## Caveats and edge cases to keep in view

- Deploy key leakage: keys are sealed but usable by any process that
  can call the executor; keep agent filesystem permissions tight
- Rollback fidelity: env/config changes between releases mean a
  rollback is a spec restore, not a time machine; documented per
  release record
- Webhook replays: dedupe window is best-effort; identical push
  events must be idempotent anyway
- Compose converter will never cover 100% of the spec; unsupported
  keys must be loud errors, not silent drops
- Healthcheck-free apps cannot use zero-gap swap; require a TCP or
  HTTP probe before the fast path is enabled
- Build logs can leak secrets echoed by build scripts; log chunks
  are scrubbed against the sealed env keys before storage
- ACME issuance needs inbound 80/443 reachability; agents behind
  NAT fall back to manual certs or DNS-01 hooks
- AI prompts must never carry sealed material, session tokens, or
  chat bodies; the adapter enforces a field allowlist
- Queue growth: finished jobs are retained for audit (bounded),
  then pruned on the hourly tick like other tables
