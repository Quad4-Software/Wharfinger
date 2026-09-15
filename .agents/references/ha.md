# HA, multi-hub, and restore drills

## Single-writer constraint

SQLite is the default store and is single-writer. The job queue is
lease-based (`jobs.lease_owner`/`lease_until`), so claiming is safe
across processes on the same file, but only one hub should run the
monitor loop, scheduler, and ingress at a time.

## Active/passive pattern

- One live hub holds the writer role. A standby runs with the
  monitor and job sweep disabled, or simply stays stopped.
- Failover: point DNS/reverse proxy at the standby, start it with
  the same `WHARFINGER_DATA_DIR` contents (or SurrealDB backend)
  and the same `WHARFINGER_SECRET_KEY`. Agents reconnect and resume
  reporting; stale leases expire and `jobs.recover()` on boot
  requeues stale claims and marks stale running jobs `unknown`
  until the agent's journal reconcile reports the outcome.
- With `[storage] driver = "surreal"` the database is shared; keep
  exactly one hub process running the monitor so checks do not
  double-fire. A monitor lease table for active/active is on the
  roadmap, not implemented.

## Queue durability invariants

- Every transition is one conditional UPDATE or a transaction;
  claim runs pick + lease-assign atomically so two claimers cannot
  take the same row.
- `job_key` dedupes enqueue; triggers are idempotent.
- Leases expire; `recover()` on startup and the periodic sweep
  requeue stale `claimed` jobs and mark stale `running` jobs
  `unknown` rather than blindly re-executing.
- The agent journals each step before running it and posts
  `/ingress/jobs/reconcile` at startup; only `unknown` jobs can be
  reconciled, and only by the job's target agent.
- `not_before` scheduling lives in the claim predicate, so a
  scheduled job cannot be claimed early even by a racing agent.

## Backup

Two layers:

- Config export: `GET /admin/api/backup` returns exportable
  sections with `${VAR}` placeholders unresolved. `?full=1` adds a
  `data` dump of deploy_apps, deploy_keys, deploy_releases,
  hub_keys, secret_sets, agents, and api_keys. Secret fields stay
  sealed in the dump; they open only under the same
  WHARFINGER_SECRET_KEY. `POST /admin/api/backup` with
  `{passphrase, full: true}` returns a passphrase-sealed envelope.
- File level: copy `wharfinger.db` plus `<data>/agent-releases/`
  while the hub is stopped, or use `sqlite3 wharfinger.db
".backup out.db"` for a hot consistent copy.

## Restore drill

1. Install a fresh hub with the same `WHARFINGER_SECRET_KEY`.
2. Stop the hub. Replace `wharfinger.db` with the file-level copy,
   or skip to step 4 for a config-only restore.
3. Restore `<data>/agent-releases/` if agent self-update binaries
   matter.
4. `POST /admin/api/backup` with the export JSON (`mode: "replace"`).
   Data tables restore row-by-row inside a transaction per table;
   the response lists applied and failed tables.
5. Start the hub, sign in, confirm agents reconnect. Stale jobs
   reconcile through the normal recover/unknown path.
6. Verify one service, one deploy app env, and one sealed secret
   work end to end.
