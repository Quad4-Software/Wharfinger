// Package traefikedge is a Traefik middleware plugin that aggregates
// request telemetry (status classes, top clients and paths, recent
// errors, latency percentiles) and ships it to a wharfinger hub.
// It stays inside the Go standard library so it can run under yaegi,
// the interpreter Traefik uses for plugins.
package traefikedge

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

// Config maps the plugin's static/dynamic configuration keys.
type Config struct {
	// HubURL is the wharfinger base URL, e.g. https://status.example.com.
	HubURL string `json:"hubUrl,omitempty"`
	// Token is a registered system bearer token (admin panel, Systems).
	Token string `json:"token,omitempty"`
	// IntervalSeconds is the aggregation window between uploads.
	IntervalSeconds int `json:"intervalSeconds,omitempty"`
	// TrustForwarded makes the plugin honor X-Forwarded-For when the
	// edge sits behind another proxy that sets it. Otherwise the
	// direct peer address wins and spoofed headers are ignored.
	TrustForwarded bool `json:"trustForwarded,omitempty"`
	// MaxClients/MaxPaths/MaxErrors bound memory per window.
	MaxClients int `json:"maxClients,omitempty"`
	MaxPaths   int `json:"maxPaths,omitempty"`
	MaxErrors  int `json:"maxErrors,omitempty"`
	// MaxLatencySamples bounds the percentile reservoir per window.
	MaxLatencySamples int `json:"maxLatencySamples,omitempty"`
}

// CreateConfig supplies Traefik's required defaults constructor.
func CreateConfig() *Config {
	return &Config{
		IntervalSeconds:   60,
		MaxClients:        64,
		MaxPaths:          128,
		MaxErrors:         128,
		MaxLatencySamples: 4096,
	}
}

type clientStat struct {
	IP       string `json:"ip"`
	Requests int    `json:"requests"`
}

type pathStat struct {
	Path     string `json:"path"`
	Requests int    `json:"requests"`
	Errors   int    `json:"errors"`
}

type errSample struct {
	Ts     int64  `json:"ts"`
	Method string `json:"method"`
	Host   string `json:"host"`
	Path   string `json:"path"`
	Status int    `json:"status"`
	IP     string `json:"ip"`
}

type report struct {
	V          int          `json:"v"`
	Ts         int64        `json:"ts"`
	WindowSec  float64      `json:"windowSec"`
	Requests   int          `json:"requests"`
	S2xx       int          `json:"s2xx"`
	S3xx       int          `json:"s3xx"`
	S4xx       int          `json:"s4xx"`
	S5xx       int          `json:"s5xx"`
	LatencyP50 float64      `json:"latencyP50,omitempty"`
	LatencyP95 float64      `json:"latencyP95,omitempty"`
	LatencyP99 float64      `json:"latencyP99,omitempty"`
	Clients    []clientStat `json:"clients,omitempty"`
	Paths      []pathStat   `json:"paths,omitempty"`
	Errors     []errSample  `json:"errors,omitempty"`
}

type counters struct {
	requests, s2xx, s3xx, s4xx, s5xx int
	latencies                        []float64
	clients                          map[string]int
	paths                            map[string]*pathStat
	errs                             []errSample
}

// Edge is the middleware instance Traefik keeps per router.
type Edge struct {
	next   http.Handler
	name   string
	cfg    *Config
	client *http.Client

	mu  sync.Mutex
	cur counters
	at  time.Time
}

// Hub-side schema caps (server/ingress/schema.ts). Values configured
// above these would make the hub reject every report.
const (
	schemaMaxClients = 64
	schemaMaxPaths   = 128
	schemaMaxErrors  = 128
	schemaMaxMidStr  = 1024
)

// New is Traefik's required middleware constructor.
func New(ctx context.Context, next http.Handler, cfg *Config, name string) (http.Handler, error) {
	if cfg.HubURL == "" || cfg.Token == "" {
		return nil, fmt.Errorf("traefikedge: hubUrl and token are required")
	}
	if u, err := url.Parse(cfg.HubURL); err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, fmt.Errorf("traefikedge: hubUrl must be an http(s) URL")
	} else if u.Scheme == "http" && !isLoopbackHost(u.Hostname()) {
		return nil, fmt.Errorf("traefikedge: hubUrl must use https for non-loopback hubs (bearer token would leak)")
	}
	if cfg.IntervalSeconds <= 0 {
		cfg.IntervalSeconds = 60
	}
	if cfg.MaxClients <= 0 || cfg.MaxClients > schemaMaxClients {
		cfg.MaxClients = schemaMaxClients
	}
	if cfg.MaxPaths <= 0 || cfg.MaxPaths > schemaMaxPaths {
		cfg.MaxPaths = schemaMaxPaths
	}
	if cfg.MaxErrors <= 0 || cfg.MaxErrors > schemaMaxErrors {
		cfg.MaxErrors = schemaMaxErrors
	}
	if cfg.MaxLatencySamples <= 0 {
		cfg.MaxLatencySamples = 4096
	}
	e := &Edge{
		next: next,
		name: name,
		cfg:  cfg,
		client: &http.Client{
			Timeout: 5 * time.Second,
		},
	}
	e.resetLocked()
	e.at = time.Now()
	go e.loop(ctx)
	return e, nil
}

func (e *Edge) resetLocked() {
	e.cur = counters{
		clients: make(map[string]int, e.cfg.MaxClients),
		paths:   make(map[string]*pathStat, e.cfg.MaxPaths),
	}
}

// ServeHTTP records one observation then delegates.
func (e *Edge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
	e.next.ServeHTTP(sw, r)
	latencyMs := float64(time.Since(start).Microseconds()) / 1000

	ip := clientIP(r, e.cfg.TrustForwarded)
	path := r.URL.Path
	if len(path) > 200 {
		path = path[:200]
	}
	e.mu.Lock()
	e.cur.requests++
	switch class := sw.status / 100; class {
	case 2:
		e.cur.s2xx++
	case 3:
		e.cur.s3xx++
	case 4:
		e.cur.s4xx++
	default:
		e.cur.s5xx++
	}
	if len(e.cur.latencies) < e.cfg.MaxLatencySamples {
		e.cur.latencies = append(e.cur.latencies, latencyMs)
	}
	if _, ok := e.cur.clients[ip]; ok || len(e.cur.clients) < e.cfg.MaxClients {
		e.cur.clients[ip]++
	}
	if ps, ok := e.cur.paths[path]; ok {
		ps.Requests++
		if sw.status >= 500 {
			ps.Errors++
		}
	} else if len(e.cur.paths) < e.cfg.MaxPaths {
		ps = &pathStat{Path: path, Requests: 1}
		if sw.status >= 500 {
			ps.Errors = 1
		}
		e.cur.paths[path] = ps
	}
	if sw.status >= 500 && len(e.cur.errs) < e.cfg.MaxErrors {
		e.cur.errs = append(e.cur.errs, errSample{
			Ts:     time.Now().UnixMilli(),
			Method: truncate(r.Method, 64),
			Host:   truncate(r.Host, 253),
			Path:   path,
			Status: sw.status,
			IP:     ip,
		})
	}
	e.mu.Unlock()
}

func (e *Edge) loop(ctx context.Context) {
	t := time.NewTicker(time.Duration(e.cfg.IntervalSeconds) * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			e.flush()
		}
	}
}

// flush snapshots and resets the window, then uploads best-effort.
// A failed upload drops the window: metrics loss is acceptable, a
// growing retry queue is not.
func (e *Edge) flush() {
	e.mu.Lock()
	cur := e.cur
	window := time.Since(e.at).Seconds()
	e.resetLocked()
	e.at = time.Now()
	e.mu.Unlock()
	if cur.requests == 0 {
		return
	}

	rep := report{
		V:         1,
		Ts:        time.Now().UnixMilli(),
		WindowSec: window,
		Requests:  cur.requests,
		S2xx:      cur.s2xx,
		S3xx:      cur.s3xx,
		S4xx:      cur.s4xx,
		S5xx:      cur.s5xx,
	}
	if len(cur.latencies) > 0 {
		sort.Float64s(cur.latencies)
		pct := func(p float64) float64 {
			i := int(p * float64(len(cur.latencies)-1))
			return cur.latencies[i]
		}
		rep.LatencyP50 = pct(0.50)
		rep.LatencyP95 = pct(0.95)
		rep.LatencyP99 = pct(0.99)
	}
	for ip, n := range cur.clients {
		rep.Clients = append(rep.Clients, clientStat{IP: ip, Requests: n})
	}
	sort.Slice(rep.Clients, func(i, j int) bool { return rep.Clients[i].Requests > rep.Clients[j].Requests })
	for _, ps := range cur.paths {
		rep.Paths = append(rep.Paths, *ps)
	}
	sort.Slice(rep.Paths, func(i, j int) bool { return rep.Paths[i].Requests > rep.Paths[j].Requests })
	rep.Errors = cur.errs

	body, err := json.Marshal(rep)
	if err != nil {
		return
	}
	url := strings.TrimRight(e.cfg.HubURL, "/") + "/ingress/edge"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+e.cfg.Token)
	res, err := e.client.Do(req)
	if err != nil {
		return
	}
	res.Body.Close()
}

// statusWriter captures the status code the handler picked. Unwrap
// lets http.ResponseController reach the underlying writer so flush,
// hijack (websocket upgrades) and friends keep working through the
// middleware.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// truncate bounds attacker-controlled strings so the hub schema
// cannot reject an entire report over one oversized value.
func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// isLoopbackHost reports whether the hub URL targets this machine,
// where plain http does not expose the bearer token to the network.
func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// clientIP honors X-Forwarded-For only when configured to trust it;
// otherwise the socket peer wins so clients cannot forge entries.
func clientIP(r *http.Request, trustForwarded bool) string {
	if trustForwarded {
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			if i := strings.Index(fwd, ","); i >= 0 {
				return strings.TrimSpace(fwd[:i])
			}
			return strings.TrimSpace(fwd)
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
