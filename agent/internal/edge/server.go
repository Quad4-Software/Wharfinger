package edge

import (
	"context"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// pollInterval is the route-table sync cadence; Poke nudges an
	// extra sync between ticks, same model as the job worker.
	pollInterval = 30 * time.Second
	// challengePrefix is the HTTP-01 interception point: it is
	// checked before any host routing so tokens are never proxied.
	challengePrefix = "/.well-known/acme-challenge/"
	// maxBodyBytes caps proxied request bodies.
	maxBodyBytes = 512 << 10
	maxRoutes    = 200
)

// Config holds the edge proxy settings. ListenTLS only binds when
// certs exist or a managed route wants TLS. DebugAddr must be a
// loopback address; anything else is refused.
type Config struct {
	ListenAddr string // default ":80"
	ListenTLS  string // default ":443"
	DebugAddr  string // e.g. "127.0.0.1:8765"; empty disables /edgez
	StateDir   string // certs and account key live under <StateDir>/edge
	ACMEDir    string // ACME directory URL; empty = Let's Encrypt prod
	DNSHook    string // optional DNS-01 hook executable
}

// Server is the agent-side reverse proxy: it owns the route table,
// the HTTP/TLS listeners, and the cert manager.
type Server struct {
	cfg    Config
	client *Client
	certs  *CertManager
	table  atomic.Value // *RouteTable
	poke   chan struct{}
	// tlsPort is appended to redirect targets when ListenTLS is not
	// the default :443 (e.g. ":8443" in tests or behind port maps).
	tlsPort string

	mu         sync.Mutex
	tlsStarted bool
	httpSrv    *http.Server
	tlsSrv     *http.Server
	dbgSrv     *http.Server
}

func NewServer(cfg Config, client *Client) (*Server, error) {
	if cfg.ListenAddr == "" {
		cfg.ListenAddr = ":80"
	}
	if cfg.ListenTLS == "" {
		cfg.ListenTLS = ":443"
	}
	var solver Solver
	if cfg.DNSHook != "" {
		solver = ExecSolver{Path: cfg.DNSHook}
	}
	s := &Server{cfg: cfg, client: client, poke: make(chan struct{}, 1)}
	if _, port, err := net.SplitHostPort(cfg.ListenTLS); err == nil && port != "443" {
		s.tlsPort = ":" + port
	}
	certs, err := NewCertManager(cfg.StateDir, cfg.ACMEDir, solver, s.routeForHost)
	if err != nil {
		return nil, err
	}
	s.certs = certs
	return s, nil
}

// Poke nudges the sync loop to poll now instead of waiting for the
// next tick; callers wire it to the job-completion notification.
func (s *Server) Poke() {
	select {
	case s.poke <- struct{}{}:
	default:
	}
}

// Certs reports the certificate inventory for the metrics payload.
func (s *Server) Certs() []CertInfo { return s.certs.inventory() }

func (s *Server) routes() *RouteTable {
	t, _ := s.table.Load().(*RouteTable)
	return t
}

// routeForHost resolves a request host through the current table;
// injected into the cert manager for on-demand obtains.
func (s *Server) routeForHost(host string) *Route {
	return s.routes().lookup(host)
}

// Start runs the listeners and background loops until ctx is done.
func (s *Server) Start(ctx context.Context) error {
	go s.syncLoop(ctx)
	go s.certs.renewLoop(ctx)

	s.httpSrv = &http.Server{
		Addr:              s.cfg.ListenAddr,
		Handler:           s.handler(false),
		MaxHeaderBytes:    1 << 20,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	go func() {
		if err := s.httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("edge: http listener %s: %v", s.cfg.ListenAddr, err)
		}
	}()
	log.Printf("edge: http listener on %s", s.cfg.ListenAddr)

	if s.cfg.DebugAddr != "" {
		if !isLoopbackAddr(s.cfg.DebugAddr) {
			log.Printf("edge: debug addr %s is not loopback; /edgez disabled", s.cfg.DebugAddr)
		} else {
			mux := http.NewServeMux()
			mux.HandleFunc("/edgez", s.serveDebug)
			s.dbgSrv = &http.Server{Addr: s.cfg.DebugAddr, Handler: mux, MaxHeaderBytes: 1 << 20}
			go func() {
				if err := s.dbgSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
					log.Printf("edge: debug listener %s: %v", s.cfg.DebugAddr, err)
				}
			}()
			log.Printf("edge: /edgez on %s", s.cfg.DebugAddr)
		}
	}

	s.ensureTLS()

	<-ctx.Done()
	sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, srv := range []*http.Server{s.httpSrv, s.tlsSrv, s.dbgSrv} {
		if srv != nil {
			_ = srv.Shutdown(sctx)
		}
	}
	return nil
}

// ensureTLS starts the TLS listener once, when certs exist or a
// managed route wants TLS (acme obtains happen inside GetCertificate
// on the first TLS request). Called after every successful sync so
// a table arriving later can still bring the listener up.
func (s *Server) ensureTLS() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tlsStarted {
		return
	}
	want := s.certs.any()
	if !want {
		if t := s.routes(); t != nil {
			for _, r := range t.Routes {
				if r.TLS != "off" {
					want = true
					break
				}
			}
		}
	}
	if !want {
		return
	}
	s.tlsStarted = true
	s.tlsSrv = &http.Server{
		Addr:              s.cfg.ListenTLS,
		Handler:           s.handler(true),
		MaxHeaderBytes:    1 << 20,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       60 * time.Second,
		TLSConfig:         s.certs.tlsConfig(),
	}
	go func() {
		if err := s.tlsSrv.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
			log.Printf("edge: tls listener %s: %v", s.cfg.ListenTLS, err)
		}
	}()
	log.Printf("edge: tls listener on %s", s.cfg.ListenTLS)
}

// handler serves both listeners. On plaintext it first intercepts
// ACME challenge tokens, then redirects to HTTPS when the route
// wants TLS and a cert exists.
func (s *Server) handler(secure bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, challengePrefix) {
			s.certs.serveChallenge(w, r)
			return
		}
		if secure {
			w.Header().Set("Strict-Transport-Security", "max-age=15552000")
		}
		host := hostOnly(r.Host)
		rt := s.routeForHost(host)
		if rt == nil {
			http.Error(w, "no route for host", http.StatusNotFound)
			return
		}
		if !secure && rt.TLS != "off" && s.certs.covers(host) {
			http.Redirect(w, r, "https://"+host+s.tlsPort+r.URL.RequestURI(), http.StatusMovedPermanently)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
		if rt.StaticRoot != "" {
			s.serveStatic(w, r, rt)
			return
		}
		s.serveProxy(w, r, rt)
	})
}

// serveDebug answers the loopback-only /edgez endpoint with the
// applied table version, routes, and cert inventory.
func (s *Server) serveDebug(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"certs": s.Certs()}
	if t := s.routes(); t != nil {
		out["version"] = t.Version
		out["routes"] = t.Routes
	} else {
		out["version"] = nil
		out["routes"] = []Route{}
	}
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

func (s *Server) syncLoop(ctx context.Context) {
	s.sync(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.poke:
		case <-time.After(pollInterval):
		}
		s.sync(ctx)
	}
}

func (s *Server) sync(ctx context.Context) {
	var seen int64
	if t := s.routes(); t != nil {
		seen = t.Version
	}
	t, err := s.client.Routes(ctx, seen)
	if err != nil {
		log.Printf("edge: route sync: %v", err)
		return
	}
	if t == nil {
		return // 304: unchanged
	}
	s.table.Store(t)
	log.Printf("edge: route table v%d applied (%d routes)", t.Version, len(t.Routes))
	s.ensureTLS()
}

// hostOnly strips the port from a Host header value and lowercases
// it; IPv6 literals keep their brackets off via SplitHostPort when a
// port is present.
func hostOnly(hostport string) string {
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		return strings.ToLower(h)
	}
	return strings.ToLower(strings.Trim(hostport, "[]"))
}

func isLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
