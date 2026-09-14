// Package config resolves agent settings from flags and environment.
// Env vars win over flags so container deployments need no CLI args.
package config

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Config holds everything the agent needs to connect and collect.
type Config struct {
	HubURL   string
	Token    string
	HubKey   string // ed25519 public key for hub signature verification (optional)
	Name     string // display name override, defaults to hostname
	Interval time.Duration
	Timeout  time.Duration
	Insecure bool // allow ws:// and http:// (dev only)
	Once     bool // collect once, print JSON, exit
	// StateDir is the explicit -state-dir/WHARFINGER_AGENT_STATE value.
	// When empty the agent tries StateDirCandidates in order.
	StateDir string
	// StateDirCandidates holds the default state dir candidates tried
	// in order when no explicit dir is set: the TOKEN_FILE directory
	// when the token came from a file, then
	// XDG_STATE_HOME/wharfinger-agent or ~/.local/state/wharfinger-agent.
	StateDirCandidates []string
	// TokenFile and KeyFile record the secret file paths that were
	// actually read, so startup can check their permissions.
	TokenFile string
	KeyFile   string
	// StrictPerms refuses startup when secret files are group- or
	// other-accessible instead of only logging a warning.
	StrictPerms bool
	// KubeInsecure allows kubelet collection over TLS without a pinned
	// CA (WHARFINGER_KUBE_INSECURE). Off by default: fail closed.
	KubeInsecure bool
	// SelfUpdate enables the periodic release check; after installing
	// a newer binary the process exits so the supervisor restarts it.
	SelfUpdate     bool
	UpdateInterval time.Duration
	// UpdateManifest points at a hub-hosted (or any static) release
	// manifest instead of api.github.com, for air-gapped fleets.
	UpdateManifest string
	// Deploy opts the agent into the hub job queue: it claims deploy
	// jobs and runs them against the local container runtime.
	Deploy bool
	// Kubeconfig pins the kubectl config used by the k8s deploy
	// runtime. Empty runs the standard discovery order: KUBECONFIG
	// env, ~/.kube/config, then the in-cluster service account.
	Kubeconfig string
	// Edge opts the agent into serving the domains declared by its
	// deployed apps: it polls the hub route table and reverse
	// proxies (or serves static roots) on the listen addrs.
	Edge          bool
	EdgeListen    string // plaintext listener, default ":80"
	EdgeListenTLS string // TLS listener, default ":443"
	// EdgeDebug binds the /edgez debug endpoint; must be loopback,
	// default "127.0.0.1:8765". Empty disables it.
	EdgeDebug string
	// ACMEDir overrides the ACME directory URL (default Let's
	// Encrypt prod). ACMEStaging selects the staging directory for
	// testing issuance without hitting rate limits.
	ACMEDir     string
	ACMEStaging bool
	// DNSHook is an executable run for DNS-01 challenges with argv
	// <action> <domain> <token> <keyAuth>. Required for wildcards.
	DNSHook string
	// Edge WAF posture: operator-managed list files (one entry per
	// line, # comments) and a per-client-IP rate limit. Blocked IPs
	// and UA substrings get 403; allowlisted IPs skip only the rate
	// limiter. The client IP is always the socket peer.
	EdgeBlockIPs  string
	EdgeAllowIPs  string
	EdgeBlockUA   string
	EdgeRate      float64 // requests/sec per client IP; <= 0 off
	EdgeRateBurst int
}

func getenv(keys ...string) string {
	for _, k := range keys {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			return v
		}
	}
	return ""
}

// getSecret reads a secret directly or from a *_FILE path, matching the
// Beszel TOKEN/TOKEN_FILE convention so docker secrets just work.
func getSecret(direct, fileEnv string) (string, error) {
	if v := getenv(direct); v != "" {
		return v, nil
	}
	if f := getenv(fileEnv); f != "" {
		b, err := os.ReadFile(f)
		if err != nil {
			return "", fmt.Errorf("read %s: %w", fileEnv, err)
		}
		return strings.TrimSpace(string(b)), nil
	}
	return "", nil
}

// Load parses flags then applies env overrides. Call once at startup.
func Load(args []string) (Config, error) {
	fs := flag.NewFlagSet("wharfinger-agent", flag.ContinueOnError)
	var c Config
	fs.StringVar(&c.HubURL, "hub", "", "hub base URL, e.g. https://status.example.com")
	fs.StringVar(&c.Token, "token", "", "registration token from the admin panel")
	fs.StringVar(&c.HubKey, "key", "", "hub ed25519 public key (base64) for signature verification")
	fs.StringVar(&c.Name, "name", "", "display name override")
	fs.DurationVar(&c.Interval, "interval", 10*time.Second, "collection interval")
	fs.DurationVar(&c.Timeout, "timeout", 10*time.Second, "per-request timeout")
	fs.BoolVar(&c.Insecure, "insecure", false, "allow plaintext ws:// and http:// hub URLs")
	fs.BoolVar(&c.Once, "once", false, "collect once, print JSON to stdout, exit")
	fs.StringVar(&c.StateDir, "state-dir", "", "state dir for agent identity key and pinned hub key")
	fs.BoolVar(&c.StrictPerms, "strict-perms", false, "refuse startup when secret files are group/other accessible")
	fs.BoolVar(&c.KubeInsecure, "kube-insecure", false, "kubelet TLS without a pinned CA (fails closed otherwise)")
	fs.BoolVar(&c.SelfUpdate, "self-update", false, "periodically update the binary from GitHub releases")
	fs.DurationVar(&c.UpdateInterval, "update-interval", 24*time.Hour, "self-update check interval")
	fs.StringVar(&c.UpdateManifest, "update-manifest", "", "release manifest URL instead of GitHub (air-gapped)")
	fs.BoolVar(&c.Deploy, "deploy", false, "claim and execute deploy jobs from the hub queue")
	fs.StringVar(&c.Kubeconfig, "kubeconfig", "", "kubectl config path for the k8s deploy runtime")
	fs.BoolVar(&c.Edge, "edge", false, "serve deployed-app domains (reverse proxy + ACME TLS)")
	fs.StringVar(&c.EdgeListen, "edge-listen", ":80", "edge plaintext listen addr")
	fs.StringVar(&c.EdgeListenTLS, "edge-listen-tls", ":443", "edge TLS listen addr")
	fs.StringVar(&c.EdgeDebug, "edge-debug", "127.0.0.1:8765", "edge /edgez debug addr (loopback only, empty disables)")
	fs.StringVar(&c.ACMEDir, "acme-dir", "", "ACME directory URL (default Let's Encrypt prod)")
	fs.BoolVar(&c.ACMEStaging, "acme-staging", false, "use the Let's Encrypt staging directory")
	fs.StringVar(&c.DNSHook, "dns-hook", "", "DNS-01 hook executable (required for wildcard certs)")
	fs.StringVar(&c.EdgeBlockIPs, "edge-block-ips", "", "file of blocked client IPs/CIDRs (one per line)")
	fs.StringVar(&c.EdgeAllowIPs, "edge-allow-ips", "", "file of client IPs/CIDRs exempt from rate limiting")
	fs.StringVar(&c.EdgeBlockUA, "edge-block-ua", "", "file of blocked user-agent substrings (one per line)")
	fs.Float64Var(&c.EdgeRate, "edge-rate", 0, "edge rate limit, requests/sec per client IP (0 disables)")
	fs.IntVar(&c.EdgeRateBurst, "edge-rate-burst", 0, "edge rate limit burst size (defaults to edge-rate)")
	if err := fs.Parse(args); err != nil {
		return c, err
	}

	if v := getenv("HUB_URL"); v != "" {
		c.HubURL = v
	}
	if v, err := getSecret("TOKEN", "TOKEN_FILE"); err != nil {
		return c, err
	} else if v != "" {
		c.Token = v
	}
	if getenv("TOKEN") == "" {
		// Only the file path that actually fed the secret is checked.
		c.TokenFile = getenv("TOKEN_FILE")
	}
	if v, err := getSecret("KEY", "KEY_FILE"); err != nil {
		return c, err
	} else if v != "" {
		c.HubKey = v
	}
	if getenv("KEY") == "" {
		c.KeyFile = getenv("KEY_FILE")
	}
	if v := getenv("WHARFINGER_AGENT_STATE"); v != "" {
		c.StateDir = v
	}
	if v := getenv("WHARFINGER_STRICT_PERMS", "STRICT_PERMS"); v == "1" || strings.EqualFold(v, "true") || strings.EqualFold(v, "on") {
		c.StrictPerms = true
	}
	if v := getenv("WHARFINGER_KUBE_INSECURE"); v == "1" || strings.EqualFold(v, "true") || strings.EqualFold(v, "on") {
		c.KubeInsecure = true
	}
	if v := getenv("SYSTEM_NAME", "NAME"); v != "" {
		c.Name = v
	}
	if v := getenv("INTERVAL"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			return c, fmt.Errorf("INTERVAL: %w", err)
		}
		c.Interval = d
	}
	if v := getenv("SELF_UPDATE"); v == "1" || strings.EqualFold(v, "true") || strings.EqualFold(v, "on") {
		c.SelfUpdate = true
	}
	if v := getenv("UPDATE_INTERVAL"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			return c, fmt.Errorf("UPDATE_INTERVAL: %w", err)
		}
		c.UpdateInterval = d
	}
	if v := getenv("UPDATE_MANIFEST"); v != "" {
		c.UpdateManifest = v
	}
	if v := getenv("WHARFINGER_AGENT_DEPLOY"); v == "1" || strings.EqualFold(v, "true") || strings.EqualFold(v, "on") {
		c.Deploy = true
	}
	if v := getenv("WHARFINGER_AGENT_KUBECONFIG"); v != "" {
		c.Kubeconfig = v
	}
	if v := getenv("WHARFINGER_AGENT_EDGE"); v == "1" || strings.EqualFold(v, "true") || strings.EqualFold(v, "on") {
		c.Edge = true
	}
	if v := getenv("WHARFINGER_AGENT_EDGE_LISTEN"); v != "" {
		c.EdgeListen = v
	}
	if v := getenv("WHARFINGER_AGENT_EDGE_LISTEN_TLS"); v != "" {
		c.EdgeListenTLS = v
	}
	if v := getenv("WHARFINGER_AGENT_EDGE_DEBUG"); v != "" {
		c.EdgeDebug = v
	}
	if v := getenv("WHARFINGER_AGENT_ACME_DIR"); v != "" {
		c.ACMEDir = v
	}
	if v := getenv("WHARFINGER_AGENT_ACME_STAGING"); v == "1" || strings.EqualFold(v, "true") || strings.EqualFold(v, "on") {
		c.ACMEStaging = true
	}
	if v := getenv("WHARFINGER_AGENT_DNS_HOOK"); v != "" {
		c.DNSHook = v
	}
	if v := getenv("WHARFINGER_AGENT_EDGE_BLOCK_IPS"); v != "" {
		c.EdgeBlockIPs = v
	}
	if v := getenv("WHARFINGER_AGENT_EDGE_ALLOW_IPS"); v != "" {
		c.EdgeAllowIPs = v
	}
	if v := getenv("WHARFINGER_AGENT_EDGE_BLOCK_UA"); v != "" {
		c.EdgeBlockUA = v
	}
	if v := getenv("WHARFINGER_AGENT_EDGE_RATE"); v != "" {
		f, err := strconv.ParseFloat(v, 64)
		if err != nil {
			return c, fmt.Errorf("WHARFINGER_AGENT_EDGE_RATE: %w", err)
		}
		c.EdgeRate = f
	}
	if v := getenv("WHARFINGER_AGENT_EDGE_RATE_BURST"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return c, fmt.Errorf("WHARFINGER_AGENT_EDGE_RATE_BURST: %w", err)
		}
		c.EdgeRateBurst = n
	}
	if c.ACMEStaging && c.ACMEDir == "" {
		c.ACMEDir = "https://acme-staging-v02.api.letsencrypt.org/directory"
	}

	c.HubURL = strings.TrimRight(c.HubURL, "/")
	if c.Once {
		// Local debug mode: print one payload, no hub or token needed.
		return c, nil
	}
	if c.StateDir == "" {
		c.StateDirCandidates = defaultStateDirs(c.TokenFile)
	}
	if c.HubURL == "" {
		return c, fmt.Errorf("hub URL required (-hub or HUB_URL)")
	}
	if c.Token == "" {
		return c, fmt.Errorf("token required (-token, TOKEN, or TOKEN_FILE)")
	}
	if c.Interval < time.Second {
		return c, fmt.Errorf("interval must be >= 1s")
	}
	if c.Interval > 15*time.Minute {
		return c, fmt.Errorf("interval must be <= 15m")
	}
	if c.UpdateInterval < time.Minute {
		return c, fmt.Errorf("update interval must be >= 1m")
	}
	scheme := strings.SplitN(c.HubURL, "://", 2)[0]
	switch scheme {
	case "https", "wss":
	case "http", "ws":
		if !c.Insecure {
			return c, fmt.Errorf("plaintext hub URL requires -insecure")
		}
	default:
		return c, fmt.Errorf("hub URL must start with https://, http://, wss://, or ws://")
	}
	return c, nil
}

// defaultStateDirs lists the state dir candidates tried in order when
// no flag or env set one: the TOKEN_FILE directory when the token came
// from a file (docker secrets and systemd credentials already isolate
// it), then the per-user state dir, then a directory relative to the
// working dir. The TOKEN_FILE directory may be a read-only mount, so
// later candidates are real fallbacks, not decoration.
func defaultStateDirs(tokenFile string) []string {
	var dirs []string
	if tokenFile != "" {
		dirs = append(dirs, filepath.Dir(tokenFile))
	}
	if xdg := os.Getenv("XDG_STATE_HOME"); xdg != "" {
		dirs = append(dirs, filepath.Join(xdg, "wharfinger-agent"))
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		dirs = append(dirs, filepath.Join(home, ".local", "state", "wharfinger-agent"))
	}
	return append(dirs, "wharfinger-agent-state")
}
