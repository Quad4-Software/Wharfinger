# Deploy architecture

## Split

- Control plane: the hub (SvelteKit + SQLite). Owns app definitions,
  release records, the job queue, webhook verification, audit, and
  the panel.
- Executor: the agent (Go). Owns source checkout, builds, container
  runtime ops, the edge proxy, and healthchecks.
- Traffic path: client -> agent edge proxy -> app container. Traffic
  never crosses the hub. If the hub dies, deployed apps keep
  serving; only new operations pause.

## Why not SSH

Coolify connects to each server over SSH and runs docker commands.
That needs inbound SSH, broad shell privileges, key distribution to
the control plane, and gives no work-queue durability on the target.
Our agents already maintain an authenticated, encrypted, signed
channel with proof of possession. Pulling jobs over it removes SSH
entirely and works behind NAT and firewalls.

## Wire protocol

- Agent connects WS (existing ingress channel). Hub may send a
  `work_available` nudge carrying only a count.
- Agent calls `GET /ingress/jobs?limit=n` with its normal auth;
  response contains at most one `deploy` job at a time per agent.
- Claim is atomic server-side. The agent acks with the lease id it
  received; a mismatched ack means another worker took it.
- Progress: agent POSTs bounded log chunks and step transitions to
  `/ingress/jobs/<id>/progress`. Hub appends to the job record.
- Result: agent POSTs `/ingress/jobs/<id>/result` with the
  idempotency key from the spec. Re-posts are deduped.

## Job spec snapshot (frozen at enqueue)

```
app_id, release_id, job_key,
source: { kind: git|image|compose|static, url, ref, commit?,
          subdir?, deploy_key_id? },
build:  { kind: dockerfile|static|compose, context?, args? },
run:    { image?, env_id, ports[], healthcheck:{kind,path|port,
          interval,timeout,retries}, resources? },
route:  { domains[], path_prefix?, tls: acme|manual|none },
rollback_of?: release_id
```

Env values are not in the spec. The spec carries `env_id`; the agent
fetches sealed env material in a separate authenticated call that
returns plaintext only to the bound agent over the encrypted channel.

## Container naming and swap

Containers are named `<app>-<release_id>`. The route points at the
release id, so a swap is: start new container, healthcheck, repoint
route atomically, stop old after drain window. Rollback deploys the
previous release's spec under a new job; the old container may still
exist and can be reused when its spec digest matches.

## Failure reconciliation

- Agent restarts mid-job: journal in state dir; on boot the agent
  reports each journaled job id plus observed container state.
- Hub restarts mid-job: leases expire; running jobs become
  `unknown` until the agent's report arrives. Never blind-requeue a
  job whose only evidence of death is silence.
- Agent offline: jobs stay `queued` with `waiting_for_agent`; the
  panel shows the reason.

## Forges, previews, and teardown (implemented)

- `src/lib/server/deploy/forge.ts` resolves the forge kind
  (github/gitlab/gitea/generic; explicit `source.forge` wins over
  hostname detection) and owns outbound calls: commit statuses and
  `listBranches` for the form's repo browse. All forge fetches go
  through rt.egress with redirect:manual and a 256KB body cap.
- PR/MR webhooks: `hook.ts` parses pull_request (github, gitea,
  forgejo) and Merge Request Hook (gitlab) events. `isPRWebhook`
  gates the route so unhandled actions never reach push parsing.
- Previews are opt-in via `source.previews`: a PR runs unreviewed
  code with the app's env, forge token, and deploy key, so the flag
  is an explicit trust decision and is stripped from preview apps
  (previews cannot spawn previews).
- Preview apps are regular deploy_apps rows with preview_of /
  preview_pr / preview_expires; name is <parent>-pr<N>, the ref is
  the forge PR head (refs/pull/<n>/head or refs/merge-requests/<n>/
  head), host ports come from a 30000-39999 loopback range, and the
  TTL is 72h. createPreviewApp dedupes on (preview_of, preview_pr)
  inside its transaction.
- `teardown` is a second claimable job kind. Its spec carries only
  appId, runtime, and namespace (no secrets). The agent removes
  <app>-* containers, <app>:* images, k8s objects by app label, and
  the src/static state dirs. Container-name prefix safety relies on
  fixed-length app ids; keep `app_` + 9 random bytes.
- Preview close, TTL sweep (on the 60s job tick), and parent delete
  all enqueue `teardown:<appId>` before deleting the row; the
  deterministic job_key dedupes racing enqueues.
