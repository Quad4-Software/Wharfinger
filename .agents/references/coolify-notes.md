# Coolify / Dokku notes and where we differ

## What Coolify does

- Control plane (PHP/Laravel) + connected servers over SSH.
- Per-deployment queued job; builds via nixpacks/railpack/static/
  dockerfile/compose or image pulls.
- Per-server traefik proxy routes domains to containers.
- GitHub App (JWT + installation tokens), GitLab token, Bitbucket,
  Gitea webhooks verified per provider.
- Replacement: new container then stop old. There is a window where
  the route points at a container that is not up yet.

## Dokku

- Single-host git-push deploys, buildpacks or Dockerfile, nginx
  vhost per app, plugin system. Simple but single-node and
  shell-heavy.

## Where we differ deliberately

- No SSH: agents pull work over an existing signed channel.
- Zero-gap swap is the default path, gated on healthcheck. Coolify's
  replacement can gap; ours refuses to cut over until proven.
- Queue is a SQLite table, not Redis/Horizon. Single-writer hub
  makes a broker pure overhead.
- Runtime default is podman (rootless), docker supported. Coolify
  is docker-only.
- Deploy keys are per-app ed25519 generated server-side, sealed at
  rest, read-only by forge convention. No broad PATs for cloning.
- Build logs are scrubbed against env secrets before upload.
- Compose ingestion is a converter to our spec with loud errors on
  unsupported keys, not a raw compose runner. Users edit validated
  fields, never generated proxy config.

## What to copy

- Per-app webhook tokens with provider-aware signature checks.
- Immutable release records so rollback is a redeploy of a frozen
  spec, not a state rewind.
- Build log streaming with a live tail in the panel.
- PR preview deployments with TTL teardown (phase 3).
