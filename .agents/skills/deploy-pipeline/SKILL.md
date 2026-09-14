---
name: deploy-pipeline
description: >
  Deploy lifecycle end to end: app spec, release records, agent
  executor protocol, zero-gap swap, rollback. Use when touching
  deploy code on hub or agent.
---

## Lifecycle

1. Trigger (panel button, webhook, API) enqueues a `deploy` job with
   a frozen spec snapshot and a new release row in `pending`.
2. Target agent pulls the job, acks the lease, journals the job to
   its state dir before starting work.
3. Executor fetches source (deploy key via GIT_SSH_COMMAND), builds,
   tags the image with the release id.
4. Swap: start new container, run healthcheck, publish route, then
   stop old. Old container is never stopped before health is proven.
5. Agent reports outcome; hub marks release `live` or `rolled_back`,
   writes audit + notify.

## Executor rules

- Journal every step to state dir before doing it. On restart,
  report journaled jobs so the hub can reconcile.
- Runtime argv is fixed. Compose env into a file, never into a
  command string.
- Healthcheck is mandatory for the zero-gap path. Apps without one
  get the labeled slow path and a panel warning.
- Log chunks are scrubbed against the app's env keys before upload.
- Bounded: build timeout, log size cap, artifact size cap.

## Rollback

- Rollback = deploy the previous release's frozen spec. It is a new
  job, not a state rewind.
- Auto-rollback triggers on healthcheck failure or crash-loop inside
  the observation window.
- A release whose app spec or env changed since it ran still rolls
  back to its own frozen spec; the panel shows what will differ.
