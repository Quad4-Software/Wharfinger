package edge

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"log"
	mrand "math/rand"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/acme"
)

const (
	// renewBefore triggers renewal when less than this remains.
	renewBefore = 30 * 24 * time.Hour
	// renewTick is how often the renewal loop rescans the cert dir
	// and checks expiry.
	renewTick     = 12 * time.Hour
	obtainTimeout = 5 * time.Minute
	// obtainRetryMin/Jitter bound the per-host backoff after a
	// failed obtain so a broken host cannot hammer the CA.
	obtainRetryMin    = 5 * time.Minute
	obtainRetryJitter = 60 * time.Second
	solverTimeout     = 60 * time.Second
)

// Solver fulfills DNS-01 challenges. domain is the authz identifier
// (bare domain, no *.), keyAuth is the ACME key authorization; the
// TXT value for _acme-challenge.<domain> is
// base64url(sha256(keyAuth)).
type Solver interface {
	Present(ctx context.Context, domain, token, keyAuth string) error
	CleanUp(ctx context.Context, domain, token, keyAuth string) error
}

// ExecSolver runs the -dns-hook program with fixed argv:
// <hook> <present|cleanup> <domain> <token> <keyAuth>. Provider
// specifics (cloudflare etc.) live in the user-supplied script, not
// in the agent.
type ExecSolver struct{ Path string }

func (s ExecSolver) run(ctx context.Context, action, domain, token, keyAuth string) error {
	cctx, cancel := context.WithTimeout(ctx, solverTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, s.Path, action, domain, token, keyAuth)
	out, err := cmd.CombinedOutput()
	if len(out) > 4096 {
		out = out[:4096]
	}
	if err != nil {
		return fmt.Errorf("dns hook %s: %v: %s", action, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (s ExecSolver) Present(ctx context.Context, domain, token, keyAuth string) error {
	return s.run(ctx, "present", domain, token, keyAuth)
}

func (s ExecSolver) CleanUp(ctx context.Context, domain, token, keyAuth string) error {
	return s.run(ctx, "cleanup", domain, token, keyAuth)
}

// certEntry is one loaded certificate with its parsed leaf.
type certEntry struct {
	host string // managed name, e.g. example.com or *.example.com
	cert tls.Certificate
	leaf *x509.Certificate
}

// obtainFlight is a per-host singleflight slot: concurrent TLS
// handshakes for the same host wait on one obtain.
type obtainFlight struct {
	done chan struct{}
	cert *tls.Certificate
	err  error
}

// CertManager owns ACME account state, issued certs, and the HTTP-01
// token store. Layout under <stateDir>/edge:
//
//	account.key       account EC private key (0600)
//	certs/<host>.pem  issued chain (0644)
//	certs/<host>.key  cert private key (0600)
//	challenges.json   token -> keyAuth issued by this process (0600)
type CertManager struct {
	dir     string
	client  *acme.Client
	solver  Solver
	managed func(host string) *Route

	mu         sync.Mutex
	certs      map[string]*certEntry
	challenges map[string]string
	flights    map[string]*obtainFlight
	retry      map[string]time.Time
	registered bool
}

func NewCertManager(stateDir, acmeDir string, solver Solver, managed func(string) *Route) (*CertManager, error) {
	dir := filepath.Join(stateDir, "edge")
	if err := os.MkdirAll(filepath.Join(dir, "certs"), 0o700); err != nil {
		return nil, fmt.Errorf("edge state dir: %w", err)
	}
	key, err := loadOrCreateAccountKey(filepath.Join(dir, "account.key"))
	if err != nil {
		return nil, err
	}
	dirURL := acmeDir
	if dirURL == "" {
		dirURL = acme.LetsEncryptURL
	}
	m := &CertManager{
		dir:        dir,
		client:     &acme.Client{Key: key, DirectoryURL: dirURL},
		solver:     solver,
		managed:    managed,
		certs:      map[string]*certEntry{},
		challenges: map[string]string{},
		flights:    map[string]*obtainFlight{},
		retry:      map[string]time.Time{},
	}
	m.loadChallenges()
	m.loadCerts()
	return m, nil
}

func loadOrCreateAccountKey(path string) (crypto.Signer, error) {
	if b, err := os.ReadFile(path); err == nil {
		blk, _ := pem.Decode(b)
		if blk == nil {
			return nil, fmt.Errorf("%s: corrupt account key", path)
		}
		return x509.ParseECPrivateKey(blk.Bytes)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		return nil, fmt.Errorf("write %s: %w", path, err)
	}
	return key, nil
}

// certBase maps a managed host name to a safe file stem.
func certBase(host string) string {
	return strings.NewReplacer("*", "_", "/", "_").Replace(host)
}

// loadCerts scans the certs dir and indexes every readable pair by
// the leaf's first DNS name. Garbage entries are skipped, not fatal.
func (m *CertManager) loadCerts() {
	entries, err := os.ReadDir(filepath.Join(m.dir, "certs"))
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".pem") {
			continue
		}
		stem := strings.TrimSuffix(name, ".pem")
		if err := m.loadCertPair(stem); err != nil {
			log.Printf("edge: cert %s: %v", stem, err)
		}
	}
}

func (m *CertManager) loadCertPair(stem string) error {
	certPEM, err := os.ReadFile(filepath.Join(m.dir, "certs", stem+".pem"))
	if err != nil {
		return err
	}
	keyPEM, err := os.ReadFile(filepath.Join(m.dir, "certs", stem+".key"))
	if err != nil {
		return err
	}
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return err
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return err
	}
	if len(leaf.DNSNames) == 0 {
		return fmt.Errorf("no DNS names")
	}
	m.mu.Lock()
	m.certs[leaf.DNSNames[0]] = &certEntry{host: leaf.DNSNames[0], cert: cert, leaf: leaf}
	m.mu.Unlock()
	return nil
}

// any reports whether at least one usable cert is loaded.
func (m *CertManager) any() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.certs) > 0
}

// entryFor returns the best loaded cert for a request host: exact
// name first, then a covering wildcard.
func (m *CertManager) entryFor(host string) *certEntry {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e := m.certs[host]; e != nil {
		return e
	}
	var best *certEntry
	for name, e := range m.certs {
		if !strings.HasPrefix(name, "*.") {
			continue
		}
		suffix := name[1:]
		if len(host) > len(suffix) && strings.HasSuffix(host, suffix) {
			if best == nil || len(suffix) > len(best.leaf.DNSNames[0]) {
				best = e
			}
		}
	}
	return best
}

// covers reports whether a loaded cert can serve host; used for the
// HTTP to HTTPS redirect decision.
func (m *CertManager) covers(host string) bool {
	e := m.entryFor(host)
	return e != nil && time.Now().Before(e.leaf.NotAfter)
}

func (m *CertManager) tlsConfig() *tls.Config {
	return &tls.Config{
		MinVersion:     tls.VersionTLS12,
		GetCertificate: m.GetCertificate,
	}
}

// GetCertificate is the tls.Config hook. Stored certs answer
// immediately; a managed acme route with no cert yet triggers an
// on-demand obtain (autocert model), so the first TLS request for a
// new host pays the issuance latency once.
func (m *CertManager) GetCertificate(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
	host := strings.ToLower(hello.ServerName)
	if e := m.entryFor(host); e != nil && time.Now().Before(e.leaf.NotAfter) {
		return &e.cert, nil
	}
	rt := m.managed(host)
	if rt == nil {
		return nil, fmt.Errorf("edge: no route for %q", host)
	}
	if rt.TLS == "manual" {
		// Manual certs are dropped into the certs dir by the user;
		// rescan once per missed handshake (or when the stored one
		// expired) so replaced files are picked up without a
		// restart.
		if e := m.entryFor(host); e == nil || time.Now().After(e.leaf.NotAfter) {
			_ = m.loadCertPair(certBase(rt.Host))
		}
		if e := m.entryFor(host); e != nil {
			return &e.cert, nil
		}
		return nil, fmt.Errorf("edge: manual cert for %q not found", host)
	}
	if rt.TLS != "acme" {
		return nil, fmt.Errorf("edge: tls off for %q", host)
	}
	ctx := hello.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	return m.obtain(ctx, rt.Host)
}

// obtain runs the per-host singleflight plus the post-failure
// backoff; concurrent handshakes share one issuance.
func (m *CertManager) obtain(ctx context.Context, name string) (*tls.Certificate, error) {
	m.mu.Lock()
	if f := m.flights[name]; f != nil {
		m.mu.Unlock()
		<-f.done
		return f.cert, f.err
	}
	if t, ok := m.retry[name]; ok && time.Now().Before(t) {
		m.mu.Unlock()
		return nil, fmt.Errorf("edge: obtain for %s backing off until %s", name, t.Format(time.RFC3339))
	}
	f := &obtainFlight{done: make(chan struct{})}
	m.flights[name] = f
	m.mu.Unlock()

	cert, err := m.doObtain(ctx, name)

	f.cert, f.err = cert, err
	close(f.done)
	m.mu.Lock()
	delete(m.flights, name)
	if err != nil {
		m.retry[name] = time.Now().Add(obtainRetryMin + time.Duration(mrand.Int63n(int64(obtainRetryJitter))))
	} else {
		delete(m.retry, name)
	}
	m.mu.Unlock()
	if err != nil {
		log.Printf("edge: obtain %s: %v", name, err)
	}
	return cert, err
}

// ensureAccount registers (or resumes) the ACME account once.
func (m *CertManager) ensureAccount(ctx context.Context) error {
	m.mu.Lock()
	if m.registered {
		m.mu.Unlock()
		return nil
	}
	m.mu.Unlock()
	// Register is idempotent for an existing account key: the CA
	// returns the current account instead of failing.
	if _, err := m.client.Register(ctx, &acme.Account{}, acme.AcceptTOS); err != nil {
		return fmt.Errorf("acme register: %w", err)
	}
	m.mu.Lock()
	m.registered = true
	m.mu.Unlock()
	return nil
}

func (m *CertManager) doObtain(ctx context.Context, name string) (*tls.Certificate, error) {
	if strings.HasPrefix(name, "*.") && m.solver == nil {
		return nil, fmt.Errorf("wildcard %s requires a dns hook (-dns-hook)", name)
	}
	cctx, cancel := context.WithTimeout(ctx, obtainTimeout)
	defer cancel()
	if err := m.ensureAccount(cctx); err != nil {
		return nil, err
	}
	order, err := m.client.AuthorizeOrder(cctx, acme.DomainIDs(name))
	if err != nil {
		return nil, fmt.Errorf("acme order: %w", err)
	}
	for _, authzURL := range order.AuthzURLs {
		az, err := m.client.GetAuthorization(cctx, authzURL)
		if err != nil {
			return nil, fmt.Errorf("acme authz: %w", err)
		}
		if az.Status == acme.StatusValid {
			continue
		}
		if az.Status != acme.StatusPending {
			return nil, fmt.Errorf("acme authz %s status %s", az.Identifier.Value, az.Status)
		}
		if err := m.fulfill(cctx, az); err != nil {
			return nil, err
		}
	}
	order, err = m.client.WaitOrder(cctx, order.URI)
	if err != nil {
		return nil, fmt.Errorf("acme wait order: %w", err)
	}

	certKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject:  pkix.Name{CommonName: strings.TrimPrefix(name, "*.")},
		DNSNames: []string{name},
	}, certKey)
	if err != nil {
		return nil, err
	}
	der, _, err := m.client.CreateOrderCert(cctx, order.FinalizeURL, csr, true)
	if err != nil {
		return nil, fmt.Errorf("acme finalize: %w", err)
	}
	return m.persist(name, der, certKey)
}

// fulfill answers one pending authorization: DNS-01 for wildcards or
// when no http-01 is offered but a solver exists, HTTP-01 otherwise.
func (m *CertManager) fulfill(ctx context.Context, az *acme.Authorization) error {
	var httpChal, dnsChal *acme.Challenge
	for _, c := range az.Challenges {
		switch c.Type {
		case "http-01":
			httpChal = c
		case "dns-01":
			dnsChal = c
		}
	}
	domain := az.Identifier.Value
	switch {
	case az.Wildcard || httpChal == nil:
		if dnsChal == nil || m.solver == nil {
			return fmt.Errorf("acme: no usable challenge for %s", domain)
		}
		return m.fulfillDNS(ctx, az, dnsChal, domain)
	default:
		return m.fulfillHTTP(ctx, az, httpChal)
	}
}

func (m *CertManager) fulfillHTTP(ctx context.Context, az *acme.Authorization, chal *acme.Challenge) error {
	keyAuth, err := m.client.HTTP01ChallengeResponse(chal.Token)
	if err != nil {
		return err
	}
	m.addChallenge(chal.Token, keyAuth)
	defer m.removeChallenge(chal.Token)
	if _, err := m.client.Accept(ctx, chal); err != nil {
		return fmt.Errorf("acme accept http-01: %w", err)
	}
	final, err := m.client.WaitAuthorization(ctx, az.URI)
	if err != nil {
		return fmt.Errorf("acme http-01 %s: %w", az.Identifier.Value, err)
	}
	if final.Status != acme.StatusValid {
		return fmt.Errorf("acme http-01 %s status %s", az.Identifier.Value, final.Status)
	}
	return nil
}

func (m *CertManager) fulfillDNS(ctx context.Context, az *acme.Authorization, chal *acme.Challenge, domain string) error {
	keyAuth, err := m.client.HTTP01ChallengeResponse(chal.Token)
	if err != nil {
		return err
	}
	if err := m.solver.Present(ctx, domain, chal.Token, keyAuth); err != nil {
		return err
	}
	defer func() {
		cctx, cancel := context.WithTimeout(context.Background(), solverTimeout)
		defer cancel()
		if err := m.solver.CleanUp(cctx, domain, chal.Token, keyAuth); err != nil {
			log.Printf("edge: dns cleanup %s: %v", domain, err)
		}
	}()
	if _, err := m.client.Accept(ctx, chal); err != nil {
		return fmt.Errorf("acme accept dns-01: %w", err)
	}
	final, err := m.client.WaitAuthorization(ctx, az.URI)
	if err != nil {
		return fmt.Errorf("acme dns-01 %s: %w", domain, err)
	}
	if final.Status != acme.StatusValid {
		return fmt.Errorf("acme dns-01 %s status %s", domain, final.Status)
	}
	return nil
}

// persist writes the chain and key atomically-ish (write then
// rename), then indexes the cert under its leaf DNS name.
func (m *CertManager) persist(name string, der [][]byte, key *ecdsa.PrivateKey) (*tls.Certificate, error) {
	var pemBuf strings.Builder
	for _, d := range der {
		if err := pem.Encode(&pemBuf, &pem.Block{Type: "CERTIFICATE", Bytes: d}); err != nil {
			return nil, err
		}
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, err
	}
	stem := certBase(name)
	certPath := filepath.Join(m.dir, "certs", stem+".pem")
	keyPath := filepath.Join(m.dir, "certs", stem+".key")
	if err := writeFile0600(certPath+".tmp", []byte(pemBuf.String())); err != nil {
		return nil, err
	}
	if err := writeFile0600(keyPath+".tmp", pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})); err != nil {
		return nil, err
	}
	_ = os.Chmod(certPath+".tmp", 0o644)
	if err := os.Rename(certPath+".tmp", certPath); err != nil {
		return nil, err
	}
	if err := os.Rename(keyPath+".tmp", keyPath); err != nil {
		return nil, err
	}
	cert, err := tls.X509KeyPair([]byte(pemBuf.String()), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}))
	if err != nil {
		return nil, err
	}
	leaf, err := x509.ParseCertificate(der[0])
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	m.certs[leaf.DNSNames[0]] = &certEntry{host: leaf.DNSNames[0], cert: cert, leaf: leaf}
	m.mu.Unlock()
	log.Printf("edge: cert for %s valid until %s", leaf.DNSNames[0], leaf.NotAfter.Format(time.RFC3339))
	return &cert, nil
}

func writeFile0600(path string, data []byte) error {
	return os.WriteFile(path, data, 0o600)
}

// Challenge store: tokens are kept in memory and on disk so a
// restart mid-order does not strand an in-flight validation. The
// proxy only ever answers tokens this process issued.
func (m *CertManager) addChallenge(token, keyAuth string) {
	m.mu.Lock()
	m.challenges[token] = keyAuth
	m.saveChallengesLocked()
	m.mu.Unlock()
}

func (m *CertManager) removeChallenge(token string) {
	m.mu.Lock()
	delete(m.challenges, token)
	m.saveChallengesLocked()
	m.mu.Unlock()
}

func (m *CertManager) challenge(token string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.challenges[token]
}

func (m *CertManager) challengesPath() string {
	return filepath.Join(m.dir, "challenges.json")
}

func (m *CertManager) saveChallengesLocked() {
	b, err := json.Marshal(m.challenges)
	if err != nil {
		return
	}
	if err := os.WriteFile(m.challengesPath(), b, 0o600); err != nil {
		log.Printf("edge: save challenges: %v", err)
	}
}

func (m *CertManager) loadChallenges() {
	b, err := os.ReadFile(m.challengesPath())
	if err != nil {
		return
	}
	var saved map[string]string
	if err := json.Unmarshal(b, &saved); err != nil {
		return
	}
	m.mu.Lock()
	m.challenges = saved
	m.mu.Unlock()
}

// serveChallenge answers HTTP-01 probes. Only tokens this process
// issued get a keyAuth; everything else is a plain 404, so the
// endpoint cannot be used to forge challenge responses.
func (m *CertManager) serveChallenge(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.URL.Path, challengePrefix)
	keyAuth := m.challenge(token)
	if token == "" || keyAuth == "" || strings.Contains(token, "/") {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("content-type", "text/plain")
	_, _ = w.Write([]byte(keyAuth))
}

// renewLoop periodically rescans the certs dir (manual additions)
// and re-obtains certs inside the renewal window. Only acme-managed
// route names renew here; manual and orphaned certs are the user's.
func (m *CertManager) renewLoop(ctx context.Context) {
	tick := time.NewTicker(renewTick)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		m.loadCerts()
		for _, e := range m.expiring() {
			rt := m.managed(e.host)
			if rt == nil || rt.TLS != "acme" {
				continue
			}
			log.Printf("edge: renewing %s (expires %s)", e.host, e.leaf.NotAfter.Format(time.RFC3339))
			if _, err := m.obtain(ctx, e.host); err != nil {
				log.Printf("edge: renew %s: %v", e.host, err)
			}
		}
	}
}

func (m *CertManager) expiring() []*certEntry {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []*certEntry
	for _, e := range m.certs {
		if time.Until(e.leaf.NotAfter) < renewBefore {
			out = append(out, e)
		}
	}
	return out
}

// inventory builds the CertInfo list the agent reports upstream:
// every stored cert plus hosts with an obtain in flight.
func (m *CertManager) inventory() []CertInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]CertInfo, 0, len(m.certs)+len(m.flights))
	now := time.Now()
	for _, e := range m.certs {
		status := "valid"
		switch {
		case now.After(e.leaf.NotAfter):
			status = "expired"
		case time.Until(e.leaf.NotAfter) < renewBefore:
			status = "expiring"
		}
		out = append(out, CertInfo{
			Host:      e.host,
			ExpiresAt: e.leaf.NotAfter.UnixMilli(),
			Issuer:    e.leaf.Issuer.String(),
			Status:    status,
		})
	}
	for host := range m.flights {
		out = append(out, CertInfo{Host: host, Status: "pending"})
	}
	return out
}
