---
name: job-queue
description: >
  How the durable SQLite job queue works and how to add a new job
  kind. Use when creating deploys, agent tasks, scheduled work, or
  anything that must survive a restart.
---

## Model

Jobs live in the `jobs` table. A job is a durable request with an
immutable spec snapshot, a lease, and an idempotency key. The queue
is the only cross-process work dispatcher; there is no broker.

Lifecycle: `queued -> claimed -> running -> succeeded | failed |
rolled_back`. `unknown` marks jobs whose outcome the hub lost track
of (restart mid-flight) until reconciliation.

## Invariants

- Spec snapshot is frozen at enqueue time. Later config edits do not
  mutate a queued or running job.
- Claiming is a single conditional UPDATE on (id, status, lease).
  Two workers cannot claim the same job.
- Leases expire. A sweeper requeues expired claims or marks them
  `unknown` when requeueing could double-execute.
- Execution must be idempotent on `job_key`. Retries reuse the key.
- Payload secrets ride sealed; job rows are auditable without them.
- Finished jobs are kept for audit (bounded), then pruned.

## Adding a job kind

1. Define the spec type in `src/lib/shared/jobs.ts`.
2. Add the kind to the `JOB_KINDS` union and its handler in the
   runner. The handler receives (job, ctx) and returns a result or
   throws; the runner owns status transitions.
3. Register the claimer: agents pull via `GET /ingress/jobs`, hub
   work runs inline. Choose per kind.
4. Write tests: claim race (two claimers, one wins), lease expiry
   recovery, idempotent retry, unknown-state reconciliation.
5. Run the security checklist in `rules/security.md`.
