# Wharfinger

> [!WARNING]
> This project is still alpha level software and being actively developed.

Self-hosted ops platform: uptime monitoring, status pages,
deployments, and infrastructure agents. One SvelteKit app, one
SQLite file, one small Go binary per host.

## What it does

- Public status pages with uptime history, incidents, maintenance
  windows, SLO targets, and service groups
- Monitoring for HTTP, TCP, DNS, ping, JSON APIs, databases, domain
  expiry, game servers, WebSockets, and push (dead man's switch)
- A Go agent that reports CPU, memory, disks, temps, GPUs,
  containers, Kubernetes, systemd/OpenRC, firewall state, and logins
- Deploys apps from any git forge to Podman, Docker, or Kubernetes
  with health-checked swaps and one-click rollback
- An edge reverse proxy on the agent with automatic TLS (ACME
  HTTP-01 and DNS-01) and static site serving
- Admin panel with OIDC/LDAP, RBAC, audit log, notifications,
  secrets, teams, anomaly detection, image scanning, and chat

## Getting started

```sh
pnpm install
pnpm dev
```

The hub reads `config/wharfinger.toml` by default; every section is
editable live from the admin panel. Production builds run as a
single Node process or the image in `docker/`.

Agents install with one command from the panel's Systems page. The
agent is a standalone Go module in `agent/` with its own README.

## Development

```sh
pnpm verify     # typecheck, lint, format, tests, knip, build
pnpm test:e2e   # playwright smoke tests
cd agent && go test ./...
```

`AGENTS.md` and `.agents/` document architecture and conventions.
`TODO.md` tracks planned work, `CHANGELOG.md` what shipped.

## License

0BSD. Do what you want.
