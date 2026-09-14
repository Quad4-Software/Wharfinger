# traefik-edge

Traefik middleware plugin that aggregates request telemetry and ships
it to a wharfinger hub over `POST /ingress/edge`. Status classes,
latency percentiles, top clients, top paths, and recent 5xx errors,
batched once per window.

## Wiring

Register a system on the hub (admin panel, Systems) to get a
`st_...` bearer token, then attach the middleware to the routers you
want observed.

As a local plugin (works with this monorepo layout):

```yaml
# traefik static config
experimental:
  localPlugins:
    traefik-edge:
      moduleName: github.com/Quad4-Software/Wharfinger/plugins/traefikedge
```

```yaml
# dynamic config
http:
  middlewares:
    edge-report:
      plugin:
        traefik-edge:
          hubUrl: https://status.example.com
          token: st_...
          intervalSeconds: 60
```

To load it through the Traefik plugin catalog instead, the directory
needs to be reachable as its own git repo (the catalog requires
`.traefik.yml` at the repository root). Mirror or subtree-split
`plugins/traefikedge` into a standalone repo and register it there.

## Options

| Key                 | Default | Notes                                      |
| ------------------- | ------- | ------------------------------------------ |
| `hubUrl`            | -       | required; https enforced unless loopback   |
| `token`             | -       | required; system bearer token from the hub |
| `intervalSeconds`   | 60      | aggregation window between uploads         |
| `trustForwarded`    | false   | honor `X-Forwarded-For` for client IPs     |
| `maxClients`        | 64      | clamped to the hub schema cap              |
| `maxPaths`          | 128     | clamped to the hub schema cap              |
| `maxErrors`         | 128     | clamped to the hub schema cap              |
| `maxLatencySamples` | 4096    | percentile reservoir per window            |

`trustForwarded` should stay off unless another proxy in front sets
`X-Forwarded-For`; otherwise clients can forge their entries.

## Behavior

- Uploads are best-effort: a failed post drops the window rather than
  growing a retry queue.
- Reports carry `v: 1` plus a millisecond timestamp; the hub enforces
  the same clock-skew window as agent metrics and dedupes on
  `(agent_id, ts)`, so retries cannot double-count.
- Memory is bounded per window; a hostile client cannot inflate the
  maps or make the hub reject a report with oversized strings.
- The wrapped `ResponseWriter` exposes `Unwrap`/`Flush`, so websocket
  upgrades and SSE keep working through the middleware.
