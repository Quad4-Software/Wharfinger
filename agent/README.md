# wharfinger-agent

Lightweight host metrics agent for wharfinger. Reads Linux `/proc`
and `/sys` directly, no node-exporter-style dependencies, and pushes a
single JSON payload to the hub on an interval.

## Transports

- **WebSocket** (preferred): `wss://<hub>/ingress/ws` with the
  Beszel-style handshake - bearer token on upgrade, hub proves itself
  by signing the token with its ed25519 key and issuing a
  per-connection nonce, agent identifies with a machine fingerprint
  plus a proof of possession (its identity key signs the nonce). Both
  bindings are TOFU on the hub side.
- **REST fallback**: `POST /ingress` with `Authorization: Bearer <token>`
  plus `x-agent-pubkey`/`x-agent-proof` headers (proof is an ed25519
  signature over the exact request body). Used automatically while the
  socket is down.

Every metrics frame is signed with the agent identity key, so once the
key is bound a stolen bearer token alone can no longer register data.
Agents that have not bound a key yet (pre-keypair binaries) are still
accepted during the compat window and show as `legacy` in the panel.

When `HUB_URL` is `http://` behind a TLS-terminating proxy, a one-time
probe of `GET /ingress/pubkey` detects a same-host redirect to `https`
and upgrades the effective URL for the rest of the process: REST posts
go over `https` and the socket dials `wss`. The upgrade is one-way;
cross-host or plaintext redirects are ignored.

Get the hub public key from `GET /ingress/pubkey` or the Systems page
and set `KEY` so the agent verifies the handshake signature.

## State directory

On first run the agent creates a state directory holding two files:

- `agent.key` - the ed25519 identity key, generated once and reused.
  The hub TOFU-binds its public half to the registration. Losing it
  means an operator must re-bind: rotating the token in the panel
  clears the key and fingerprint bindings.
- `hub.key` - the pinned hub public key, seeded from `KEY`/`KEY_FILE`
  or adopted by TOFU on first contact.

Resolution order for the directory: `-state-dir`, then
`WHARFINGER_AGENT_STATE`. Without either, candidates are tried in order
and the first writable one wins: the directory containing `TOKEN_FILE`
when the token came from a file (it may be a read-only secrets mount,
in which case it is skipped), then `$XDG_STATE_HOME/wharfinger-agent` or
`~/.local/state/wharfinger-agent`, then `wharfinger-agent-state` relative to
the working directory. The chosen directory is logged at startup.
The directory is created `0700` and files `0600`.

## Hub key rotation

Operators can rotate the hub signing key from the panel API
(`POST /admin/api/agents/rotate-hub-key`). The old key signs the new
public key and the hub advertises that proof on `GET /ingress/pubkey`.
When a handshake signature fails against the pinned key, the agent
fetches that endpoint once: a valid proof (verifiable with the pinned
key over the new raw pubkey bytes) adopts the new key, rewrites
`hub.key`, and retries the handshake once. A missing or invalid proof
is a hard failure logged as a possible MITM; the old pin is kept.

Two edge cases:

- **No pin at all** (no `KEY`, no `hub.key`): the agent adopts
  whatever `/ingress/pubkey` returns on first contact and persists it
  (TOFU). Make sure first contact happens on a trusted network.
- **Two rotations while offline**: the proof chain only goes one
  rotation deep, so an agent pinned to a key that is two rotations
  stale cannot verify it. Re-pin manually by updating `KEY` or
  deleting `hub.key` and reconnecting on a trusted network.

A stale `KEY` env/flag always wins at startup and rewrites `hub.key`;
after a real rotation the agent converges on the new key but fetches
the pubkey endpoint once per boot until `KEY` is updated.

## File permission checks

At startup the agent stats `TOKEN_FILE`, `KEY_FILE`, the state dir,
`agent.key`, and `hub.key`. Anything group- or other-accessible
(mode `& 0077`) is logged loudly. `-strict-perms` (or
`WHARFINGER_STRICT_PERMS=1`) refuses to start instead. Nothing is
chmodded automatically; fix permissions yourself.

## Configuration

Flags and env vars; env wins. Secrets also accept `*_FILE` variants
(docker secrets).

| Flag               | Env                                | Default            | Notes                                 |
| ------------------ | ---------------------------------- | ------------------ | ------------------------------------- |
| `-hub`             | `HUB_URL`                          | required           | `https://status.example.com`          |
| `-token`           | `TOKEN`, `TOKEN_FILE`              | required           | one-time token from Systems           |
| `-key`             | `KEY`, `KEY_FILE`                  | -                  | hub ed25519 public key (base64)       |
| `-name`            | `NAME`, `SYSTEM_NAME`              | hostname           | display name                          |
| `-interval`        | `INTERVAL`                         | `10s`              | 1s to 15m                             |
| `-timeout`         | -                                  | `10s`              | request/connect timeout               |
| `-insecure`        | -                                  | off                | allow `http://`/`ws://` (dev only)    |
| `-once`            | -                                  | -                  | collect once, print JSON, exit        |
| `-state-dir`       | `WHARFINGER_AGENT_STATE`           | see above          | identity key + pinned hub key dir     |
| `-strict-perms`    | `WHARFINGER_STRICT_PERMS`          | off                | refuse startup on loose secret perms  |
| `-kube-insecure`   | `WHARFINGER_KUBE_INSECURE`         | off                | kubelet TLS without a pinned CA       |
| `-self-update`     | `SELF_UPDATE`                      | off                | set `1` for periodic self-update      |
| `-update-interval` | `UPDATE_INTERVAL`                  | `24h`              | self-update check interval (>= 1m)    |
| `-update-manifest` | `UPDATE_MANIFEST`                  | -                  | release manifest URL, replaces GitHub |
| `-edge`            | `WHARFINGER_AGENT_EDGE`            | off                | serve deployed-app domains            |
| `-edge-listen`     | `WHARFINGER_AGENT_EDGE_LISTEN`     | `:80`              | edge plaintext listen addr            |
| `-edge-listen-tls` | `WHARFINGER_AGENT_EDGE_LISTEN_TLS` | `:443`             | edge TLS listen addr                  |
| `-edge-debug`      | `WHARFINGER_AGENT_EDGE_DEBUG`      | `127.0.0.1:8765`   | /edgez addr, loopback only            |
| `-acme-dir`        | `WHARFINGER_AGENT_ACME_DIR`        | Let's Encrypt prod | ACME directory URL                    |
| `-acme-staging`    | `WHARFINGER_AGENT_ACME_STAGING`    | off                | use the LE staging directory          |
| `-dns-hook`        | `WHARFINGER_AGENT_DNS_HOOK`        | -                  | DNS-01 hook executable                |

`WHARFINGER_PROC_ROOT`/`WHARFINGER_SYS_ROOT` relocate `/proc` and `/sys` for
container deployments (the agent image sets them to `/host/...`).

Optional collector env vars:

| Env                           | Default                         | Notes                                  |
| ----------------------------- | ------------------------------- | -------------------------------------- |
| `WHARFINGER_TRAEFIK_API`      | `http://127.0.0.1:8080`         | traefik `--api` base URL               |
| `WHARFINGER_KUBE_TOKEN`       | -                               | kubelet bearer token                   |
| `WHARFINGER_KUBE_TOKEN_FILE`  | in-cluster service account path | alternative to `WHARFINGER_KUBE_TOKEN` |
| `WHARFINGER_KUBE_CA_FILE`     | -                               | pins the cluster CA for `:10250`       |
| `WHARFINGER_KUBE_TLS_NAME`    | -                               | SNI/hostname override for the CA       |
| `WHARFINGER_KUBE_INSECURE`    | -                               | `1` allows unverified `:10250` TLS     |
| `WHARFINGER_RETICULUM_CONFIG` | -                               | reticulum config path override         |

Kubernetes detection tries the legacy read-only kubelet port `10255`
first, then authenticated `10250`. Port `10250` fails closed: without
a CA pinned by `WHARFINGER_KUBE_CA_FILE` the kubelet collection is skipped
entirely (one log line), unless `WHARFINGER_KUBE_INSECURE=1` or
`-kube-insecure` explicitly accepts unverified TLS. A CA file that is
set but unreadable or unparseable behaves like no CA.

## Edge proxy

`-edge` (or `WHARFINGER_AGENT_EDGE=1`) turns the agent into the serving
edge for apps deployed to it. The agent polls
`GET /ingress/routes` every 30s (and on each finished deploy via
Poke), keeps the table in memory, and for every declared domain
either reverse-proxies to the live container
(`<appId>-<releaseId>:<port>` on the podman/docker network, or the
app's ClusterIP service on k8s) or serves files for static apps.
Proxied requests get X-Forwarded-For/Proto and a 512KB body cap; the
upstream hop is capped at 10s dial / 60s total.

TLS: routes marked acme get certificates on demand, autocert style.
The first TLS handshake for a managed host runs a full ACME order
inside a per-host singleflight; certs persist under
`<state-dir>/edge/` (`account.key`, `certs/<host>.pem|key`,
`challenges.json`, all owner-only) and renew when under 30 days
remain. HTTP-01 tokens are intercepted at
`/.well-known/acme-challenge/` before any host routing and only
tokens this process issued get a response. Use `-acme-staging`
while testing issuance. Routes marked manual serve certs you drop
into `<state-dir>/edge/certs/` yourself (rescan happens on each
missed handshake and every 12h). Routes marked off stay plain HTTP;
otherwise HTTP redirects to HTTPS once a cert exists. TLS floor is
1.2 and TLS responses carry HSTS.

`/edgez` on `-edge-debug` (default `127.0.0.1:8765`, loopback only)
dumps the applied table version, routes, and cert inventory.

### DNS-01 hook

Wildcard certificates and domains without inbound HTTP reachability
need DNS-01. `-dns-hook /path/to/script` is invoked with fixed argv:

```
<script> present <domain> <token> <keyAuth>
<script> cleanup <domain> <token> <keyAuth>
```

The script must publish (and later remove) the TXT record
`_acme-challenge.<domain>` whose value is
`base64url(sha256(keyAuth))`. Exit 0 means the record is live.
Provider specifics (Cloudflare, Route53, RFC 2136) live in the
script; the agent never sees provider credentials. A 60s timeout
applies per call.

### Integrator wiring

The edge package is not started yet; wiring lands with the
main.go owner. In `cmd/wharfinger-agent/main.go`, next to the deploy
executor block:

```go
if cfg.Edge {
	ec := edge.NewClient(ep, cfg, id)
	es, err := edge.NewServer(edge.Config{
		ListenAddr: cfg.EdgeListen,
		ListenTLS:  cfg.EdgeListenTLS,
		DebugAddr:  cfg.EdgeDebug,
		StateDir:   st.Dir(),
		ACMEDir:    cfg.ACMEDir,
		DNSHook:    cfg.DNSHook,
	}, ec)
	if err != nil {
		log.Printf("edge: disabled: %v", err)
	} else {
		collect.AgentCaps = append(collect.AgentCaps, "edge")
		go es.Start(ctx)
		// Nudge the table sync when a deploy job finishes:
		// es.Poke() after ex.Execute(...) inside the claim loop.
		// Cert inventory for the metrics payload: es.Certs().
	}
}
```

## Install

One-liner (systemd and OpenRC; downloads the binary, verifies the
release checksum, writes `/etc/wharfinger-agent.env`, installs and starts
the service):

```sh
curl -fsSL https://github.com/Quad4-Software/Wharfinger/releases/latest/download/install.sh \
  | sh -s -- --hub https://status.example.com --token st_... --key ...
```

`--name`, `--interval`, `--version`, and `--uninstall` are supported;
re-running upgrades in place. The unit files shipped with the release
(`wharfinger-agent.service`, `wharfinger-agent.openrc`) also live in
`agent/systemd/` and `agent/openrc/` for manual setups.

Manual binary run (release assets ship `SHA256SUMS.txt`):

```sh
curl -LO https://github.com/Quad4-Software/Wharfinger/releases/latest/download/wharfinger-agent-linux-amd64
chmod +x wharfinger-agent-linux-amd64
HUB_URL=https://status.example.com TOKEN=st_... KEY=... ./wharfinger-agent-linux-amd64
```

## Self-update

The agent can update itself from GitHub releases, no package manager
involved:

```sh
wharfinger-agent update    # one-shot check + install, prints the result
```

or periodically inside the running service with `SELF_UPDATE=1` (or
`-self-update`) and `UPDATE_INTERVAL` (default `24h`, minimum `1m`).

The flow is the same for both paths: fetch the latest release metadata
from `api.github.com`, compare semver against the running version
(prereleases never count as newer than the same triple), download
`wharfinger-agent-linux-<arch>` and `SHA256SUMS.txt` over https only,
verify the sha256, then atomically replace the executable: write
`<exe>.new`, fsync, `chmod 0755`, `rename`. A `<exe>.update-lock` file
blocks concurrent updates, and any failure aborts with no partial
state left behind.

Restart behavior differs per path:

- **Periodic (`SELF_UPDATE=1`)**: after a successful install the agent
  exits 0. systemd `Restart=always` (or supervise-daemon on OpenRC)
  restarts it on the new binary automatically.
- **Manual (`wharfinger-agent update`)**: the command installs the binary
  and exits. A running service keeps the old binary in memory until it
  is restarted (`systemctl restart wharfinger-agent` or `rc-service
wharfinger-agent restart`), or until its own periodic check exits.

Air-gapped or firewalled fleets can skip GitHub entirely: upload the
release binaries in the hub's Systems panel (Hosted agent releases)
and point the agent at the hub manifest instead:

```sh
UPDATE_MANIFEST=https://status.example.com/api/agent-release/manifest \
  wharfinger-agent update
```

The manifest advertises each file's sha256, so integrity is identical
to the GitHub path. Plain `http://` hubs also work when `-insecure` is
set, matching the hub URL rules.

Docker (host mounts for full coverage):

```sh
docker run -d --name wharfinger-agent --restart unless-stopped --network host \
  -e HUB_URL=https://status.example.com -e TOKEN=st_... -e KEY=... \
  -v /proc:/host/proc:ro -v /sys:/host/sys:ro \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  ghcr.io/quad4-software/wharfinger-agent:latest
```

## What it collects

CPU (total/per-core/freq), load, memory+swap, filesystems and inode
use, disk IO, temps (hwmon + thermal zones), GPUs (nvidia-smi plus
AMD/Intel sysfs), network throughput per interface, connection counts,
listening ports with owning processes, top processes by recent CPU
(kernel threads excluded), docker + podman containers (state, cpu,
memory, restarts, runtime label; rootful and rootless podman sockets),
kubernetes pods on the local kubelet (phase counts, restarts, capped
pod list), traefik inventory when the API handler is reachable
(router/service/middleware totals plus warnings and errors), Reticulum
nodes (reticulum-go daemon or Python rnsd: liveness, transport identity,
per-interface status/peers/traffic, path count, and rgoslow findings),
systemd + OpenRC services, UFW state, fail2ban jails with banned IPs,
CrowdSec decision/alert counts with a capped ban sample via `cscli`,
and login/ssh activity: current `who` sessions, recent sshd
accepted/failed events, a 24h failure count, and the top offending
source IPs.

Every collector degrades gracefully: missing tools or unreadable
interfaces simply omit that section of the payload.

## Caveats

- Container: `systemctl`, `ufw`, and `fail2ban-client` report the
  container's view, not the host's. Docker metrics need the socket
  mount; they are skipped without it.
- Container: `/proc/net` is per network namespace, so without
  `--network=host` the ports/connections/net sections reflect the
  container's own namespace. Run with `--network host` for full
  coverage.
- Reticulum collection prefers the Control API (`enable_control_api` +
  a readable `rpc_key` in the config) and falls back to parsing
  `reticulum-go status` or `rnstatus`. The agent needs read access to
  `~/.reticulum-go/config` (or `WHARFINGER_RETICULUM_CONFIG`) for the API
  path; without it the CLI fallback still reports interfaces.
- Login/ssh activity prefers `journalctl -u ssh -u sshd` and falls
  back to tailing the last 64KB of `/var/log/auth.log` or
  `/var/log/secure`. All three can require root or `adm` group
  membership; when none is readable the section reports
  `partial`/`note` so the panel can flag a permission gap instead of
  showing an empty event list. Recommended: run the agent in the
  `adm` group (`SupplementaryGroups=adm` in the unit, or add the
  service user to `adm`).
- OpenRC detection looks for `/run/openrc` and `rc-service`.
- Ports-to-process mapping reads `/proc/*/fd`; with `DynamicUser` or
  hidepid mounts some entries resolve as kernel/unknown.
- The fingerprint uses machine-id/dmi product_uuid; hosts without
  either report an empty fingerprint and skip binding.
- Self-update writes to the executable's directory. The shipped
  systemd unit opens `ReadWritePaths=/usr/local/bin` for exactly this;
  a manually hardened unit (read-only `/usr`) makes updates fail
  cleanly instead of replacing the binary.
