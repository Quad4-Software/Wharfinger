// wharfinger-agent collects host metrics and pushes them to a wharfinger
// hub. WebSocket is the primary transport; REST POST is the fallback.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Quad4-Software/Wharfinger/agent/internal/collect"
	"github.com/Quad4-Software/Wharfinger/agent/internal/config"
	"github.com/Quad4-Software/Wharfinger/agent/internal/deploy"
	"github.com/Quad4-Software/Wharfinger/agent/internal/edge"
	"github.com/Quad4-Software/Wharfinger/agent/internal/fingerprint"
	"github.com/Quad4-Software/Wharfinger/agent/internal/scan"
	"github.com/Quad4-Software/Wharfinger/agent/internal/send"
	"github.com/Quad4-Software/Wharfinger/agent/internal/state"
	"github.com/Quad4-Software/Wharfinger/agent/internal/update"
)

func main() {
	log.SetFlags(0)
	log.SetPrefix("wharfinger-agent: ")

	// wharfinger-agent update: manual self-update, print the result, exit.
	// Runs without hub config so it works as a standalone tool.
	if len(os.Args) > 1 && os.Args[1] == "update" {
		runUpdate()
		return
	}

	// wharfinger-agent setup: one-shot host provisioning (packages,
	// service user, sudoers). Prints a plan by default; -yes executes.
	if len(os.Args) > 1 && os.Args[1] == "setup" {
		runSetup(os.Args[2:])
		return
	}

	cfg, err := config.Load(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "wharfinger-agent:", err)
		os.Exit(2)
	}

	sampler := collect.NewSampler(cfg.Name, collect.AgentVersion)

	if cfg.Once {
		p := sampler.Collect()
		b, _ := json.MarshalIndent(p, "", "  ")
		fmt.Println(string(b))
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if cfg.KubeInsecure {
		collect.KubeInsecure = true
	}

	// State dir holds the agent identity key (agent.key, signs the
	// handshake nonce and every metrics frame) and the pinned hub key
	// (hub.key, updated only by a valid rotation proof or an explicit
	// KEY change). With no explicit dir, candidates are tried in order
	// because the TOKEN_FILE directory may be a read-only mount.
	stateDirs := cfg.StateDirCandidates
	if cfg.StateDir != "" {
		stateDirs = []string{cfg.StateDir}
	}
	st, err := state.OpenFirst(stateDirs)
	if err != nil {
		fmt.Fprintln(os.Stderr, "wharfinger-agent:", err)
		os.Exit(2)
	}
	log.Printf("state dir: %s", st.Dir())
	id, err := st.Identity()
	if err != nil {
		fmt.Fprintln(os.Stderr, "wharfinger-agent:", err)
		os.Exit(2)
	}

	// Secret-file hygiene: report group/other-readable files loudly;
	// -strict-perms turns the findings into a hard failure. Nothing
	// is chmodded automatically.
	permIssues := state.PermIssues(cfg.TokenFile, cfg.KeyFile, st.Dir(), st.IdentityPath(), st.HubKeyPath())
	for _, issue := range permIssues {
		log.Printf("WARNING: %s", issue)
	}
	if cfg.StrictPerms && len(permIssues) > 0 {
		fmt.Fprintf(os.Stderr, "wharfinger-agent: strict-perms: %d permission issue(s) found\n", len(permIssues))
		os.Exit(2)
	}

	pin, err := send.NewHubPin(cfg, st)
	if err != nil {
		fmt.Fprintln(os.Stderr, "wharfinger-agent:", err)
		os.Exit(2)
	}

	fp := fingerprint.Get()
	// ep owns the effective hub URL: it can upgrade http to https
	// when the hub redirects plaintext to TLS on the same host.
	ep := send.NewEndpoint(cfg.HubURL)
	ep.PlaintextWarn()
	ws := send.NewWSClient(cfg, ep, id, pin)
	defer ws.Close()

	// Store-and-forward: when the hub itself is unreachable, samples
	// queue in a bounded buffer and flush as backfill on recovery.
	buf := send.NewBuffer()

	// deliver returns the pending job count the hub piggybacks on a
	// REST response, or -1 when there is no count (ws path, older
	// hubs): the job poller covers those cases on its own cadence.
	// REST posts run off the collection loop so a slow hub cannot
	// stall sampling or pings; at most one is in flight, and a tick
	// that finds one running buffers its sample (drop-on-busy).
	var postGate send.DropOnBusy
	type postResult struct {
		p       *collect.Payload
		pending int
		err     error
	}
	postDone := make(chan postResult, 1)
	deliver := func(p *collect.Payload) (int, error) {
		if ws.Connected() {
			return -1, ws.Send(p)
		}
		if !postGate.Acquire() {
			return -1, errPostBusy
		}
		go func() {
			defer postGate.Release()
			pending, err := send.PostOnce(ep, cfg, id, p)
			postDone <- postResult{p, pending, err}
		}()
		return -1, nil
	}

	// Deploy executor: opt-in via -deploy/WHARFINGER_AGENT_DEPLOY. When
	// no container runtime is usable the executor stays nil, the
	// "deploy" capability is not advertised, and the hub never
	// targets jobs here.
	var ex *deploy.Executor
	var sx *scan.Executor
	if cfg.Deploy {
		var derr error
		ex, derr = deploy.NewExecutor(st.Dir(), deploy.NewClient(ep, cfg, id), nil, cfg.Kubeconfig)
		if derr != nil {
			log.Printf("deploy: disabled: %v", derr)
		} else {
			collect.AgentCaps = append(collect.AgentCaps, "deploy")
			log.Printf("deploy: enabled (%s)", ex.RuntimeName())
			if ex.KubeAvailable() {
				// Detection ran once above and is cached on the
				// executor; the cap tells the hub k8s specs may
				// target this agent.
				collect.AgentCaps = append(collect.AgentCaps, "k8s")
				log.Printf("deploy: k8s via %s kubeconfig", ex.KubeSource())
			}
			// Scan jobs share the deploy opt-in and the sequential
			// claim loop; trivy is resolved per job so installing it
			// later (setup) needs no restart.
			sx = scan.NewExecutor(scan.NewClient(ep, cfg, id))
			collect.AgentCaps = append(collect.AgentCaps, "scan")
		}
	}
	// Edge proxy: opt-in via -edge/WHARFINGER_AGENT_EDGE. The server
	// polls the hub route table on its own timer; es.Poke() nudges
	// a resync right after a deploy lands so a new release's domain
	// goes live without waiting for the next tick.
	var es *edge.Server
	var edgeCerts func() []collect.EdgeCert
	if cfg.Edge {
		ec := edge.NewClient(ep, cfg, id)
		var eerr error
		es, eerr = edge.NewServer(edge.Config{
			ListenAddr: cfg.EdgeListen,
			ListenTLS:  cfg.EdgeListenTLS,
			DebugAddr:  cfg.EdgeDebug,
			StateDir:   st.Dir(),
			ACMEDir:    cfg.ACMEDir,
			DNSHook:    cfg.DNSHook,
			WAF: edge.PolicyConfig{
				BlockIPs:  cfg.EdgeBlockIPs,
				AllowIPs:  cfg.EdgeAllowIPs,
				BlockUA:   cfg.EdgeBlockUA,
				Rate:      cfg.EdgeRate,
				RateBurst: cfg.EdgeRateBurst,
			},
		}, ec)
		if eerr != nil {
			log.Printf("edge: disabled: %v", eerr)
		} else {
			// "edge-proxy" stays distinct from the long-standing
			// "edge" cap, which marks the traefik telemetry plugin.
			collect.AgentCaps = append(collect.AgentCaps, "edge-proxy")
			edgeCerts = func() []collect.EdgeCert {
				infos := es.Certs()
				out := make([]collect.EdgeCert, len(infos))
				for i, c := range infos {
					out[i] = collect.EdgeCert{
						Host:      c.Host,
						ExpiresAt: c.ExpiresAt,
						Issuer:    c.Issuer,
						Status:    c.Status,
					}
				}
				return out
			}
			go func() {
				if err := es.Start(ctx); err != nil {
					log.Printf("edge: %v", err)
				}
			}()
			log.Printf("edge: serving on %s", cfg.EdgeListen)
		}
	}

	// jobPoke nudges the worker when a metrics response reports
	// queued work; the worker also polls on its own timer so ws-only
	// agents (which never see the count) still pick jobs up.
	jobPoke := make(chan struct{}, 1)
	pokeJobs := func() {
		select {
		case jobPoke <- struct{}{}:
		default:
		}
	}
	if ex != nil {
		go func() {
			// Jobs the hub lost track of while this agent was down
			// are reported once at startup from the journal.
			if err := ex.Reconcile(ctx); err != nil {
				log.Printf("deploy reconcile: %v", err)
			}
			for {
				select {
				case <-ctx.Done():
					return
				case <-jobPoke:
				case <-time.After(30 * time.Second):
				}
				// Sequential claims: one job at a time per agent so
				// two jobs never fight over ports or the runtime.
				// Deploys drain first, then scans.
				for {
					job, err := ex.Claim(ctx)
					if err != nil {
						log.Printf("deploy claim: %v", err)
						break
					}
					if job == nil {
						if sx == nil {
							break
						}
						sjob, serr := sx.Claim(ctx)
						if serr != nil {
							log.Printf("scan claim: %v", serr)
							break
						}
						if sjob == nil {
							break
						}
						log.Printf("scan: running job %d (attempt %d)", sjob.ID, sjob.Attempt)
						if err := sx.Execute(ctx, sjob); err != nil {
							log.Printf("scan job %d: %v", sjob.ID, err)
						}
						continue
					}
					log.Printf("deploy: running job %d (attempt %d)", job.ID, job.Attempt)
					if err := ex.Execute(ctx, job); err != nil {
						log.Printf("deploy job %d: %v", job.ID, err)
					}
					if es != nil {
						es.Poke()
					}
				}
			}
		}()
	}

	// Backoff for reconnect attempts; reset on successful connect.
	backoff := time.Second
	nextDial := time.Now()

	tick := time.NewTicker(cfg.Interval)
	defer tick.Stop()
	ping := time.NewTicker(send.PingInterval)
	defer ping.Stop()

	// Periodic self-update: one early check, then on the configured
	// interval. A successful install exits so the supervisor
	// (systemd Restart=always, supervise-daemon) restarts the new
	// binary.
	var updateTick, firstUpdate <-chan time.Time
	if cfg.SelfUpdate {
		ut := time.NewTicker(cfg.UpdateInterval)
		defer ut.Stop()
		updateTick = ut.C
		ft := time.NewTimer(time.Minute)
		defer ft.Stop()
		firstUpdate = ft.C
		log.Printf("self-update enabled, checking every %s", cfg.UpdateInterval)
	}

	log.Printf("reporting to %s every %s", cfg.HubURL, cfg.Interval)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ping.C:
			if ws.Connected() {
				_ = ws.Ping()
			}
		case res := <-postDone:
			// An async REST post finished; a failed payload goes back
			// on the buffer. It may land behind newer queued samples,
			// but every payload carries its own timestamp.
			if res.err != nil {
				buf.Push(res.p)
				log.Printf("ingress: %v (buffered, %d queued)", res.err, buf.Len())
			} else if res.pending > 0 {
				pokeJobs()
			}
		case <-firstUpdate:
			if selfUpdate(ctx, cfg) {
				return
			}
		case <-updateTick:
			if selfUpdate(ctx, cfg) {
				return
			}
		case <-tick.C:
			p := sampler.Collect()
			if edgeCerts != nil {
				p.EdgeCerts = edgeCerts()
			}
			if !ws.Connected() && !time.Now().Before(nextDial) {
				dctx, cancel := context.WithTimeout(ctx, cfg.Timeout)
				err := ws.Connect(dctx, fp)
				cancel()
				if err != nil {
					log.Printf("ws: %v (rest fallback active)", err)
					nextDial = time.Now().Add(jitterBackoff(backoff))
					backoff = min(backoff*2, 60*time.Second)
				} else {
					backoff = time.Second
					nextDial = time.Now()
					log.Printf("ws: connected")
				}
			}
			// Flush the outage backlog before the live sample so the
			// hub sees history in order; pace it so a long gap does
			// not burst into the ingress rate limiter. The drain is
			// capped per tick so recovery cannot monopolize the loop.
			backlog := buf.DrainMax(backfillMaxPerTick)
			for i, old := range backlog {
				old.Backfill = true
				if _, err := deliver(old); err != nil {
					buf.PushAll(backlog[i:])
					log.Printf("backfill paused: %v", err)
					break
				}
				time.Sleep(25 * time.Millisecond)
			}
			pending, err := deliver(p)
			if err != nil {
				buf.Push(p)
				log.Printf("ingress: %v (buffered, %d queued)", err, buf.Len())
			} else if pending > 0 {
				pokeJobs()
			}
		}
	}
}

// runUpdate handles the update subcommand: check, download, verify,
// install, print the result. The running service keeps the old
// binary in memory until it is restarted, so the message says so.
func runUpdate() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	tag, err := applyUpdate(ctx, config.Config{
		UpdateManifest: os.Getenv("UPDATE_MANIFEST"),
		Insecure:       os.Getenv("INSECURE") == "1",
	})
	switch {
	case err != nil:
		fmt.Fprintln(os.Stderr, "wharfinger-agent: update:", err)
		os.Exit(1)
	case tag == "":
		fmt.Printf("wharfinger-agent %s is up to date\n", collect.AgentVersion)
	default:
		fmt.Printf("wharfinger-agent updated to %s; restart the service to run it\n", tag)
	}
}

// applyUpdate picks the release source: a hub-hosted manifest when
// configured (air-gapped fleets), otherwise GitHub releases.
func applyUpdate(ctx context.Context, cfg config.Config) (string, error) {
	if cfg.UpdateManifest != "" {
		return update.ApplyManifest(ctx, collect.AgentVersion, cfg.UpdateManifest, cfg.Insecure)
	}
	return update.Apply(ctx, collect.AgentVersion)
}

// selfUpdate runs one periodic check. Returning true means a new
// binary was installed and main should exit; the supervisor then
// restarts the service on the new version.
func selfUpdate(ctx context.Context, cfg config.Config) bool {
	uctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	tag, err := applyUpdate(uctx, cfg)
	if err != nil {
		log.Printf("self-update: %v", err)
		return false
	}
	if tag == "" {
		return false
	}
	log.Printf("self-update: installed %s, restarting on the new binary", tag)
	return true
}
