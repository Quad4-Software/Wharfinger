package edge

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Quad4-Software/Wharfinger/agent/internal/config"
	"github.com/Quad4-Software/Wharfinger/agent/internal/send"
)

// newTestServer builds a Server without a hub client; the cert
// manager is real but empty (stateDir is the agent state dir).
func newTestServer(t *testing.T, stateDir string, routes ...Route) *Server {
	t.Helper()
	s := &Server{cfg: Config{StateDir: stateDir}, poke: make(chan struct{}, 1)}
	certs, err := NewCertManager(stateDir, "", nil, s.routeForHost)
	if err != nil {
		t.Fatalf("NewCertManager: %v", err)
	}
	s.certs = certs
	s.table.Store(&RouteTable{Version: 1, Routes: routes})
	return s
}

func doReq(t *testing.T, h http.Handler, host, path string, secure bool) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "http://"+host+path, nil)
	req.Host = host
	if secure {
		req.TLS = &tls.ConnectionState{}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestProxyRoutesToUpstream(t *testing.T) {
	var gotHost, gotProto, gotXFF string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost = r.Host
		gotProto = r.Header.Get("X-Forwarded-Proto")
		gotXFF = r.Header.Get("X-Forwarded-For")
		w.Write([]byte("upstream-body"))
	}))
	defer up.Close()
	upAddr := strings.TrimPrefix(up.URL, "http://")

	s := newTestServer(t, t.TempDir(), Route{Host: "app.example.com", Upstream: upAddr, TLS: "off"})
	rec := doReq(t, s.handler(false), "app.example.com", "/hello", false)
	if rec.Code != 200 || rec.Body.String() != "upstream-body" {
		t.Fatalf("proxy got %d %q", rec.Code, rec.Body.String())
	}
	if gotHost != strings.Split(upAddr, ":")[0] {
		t.Fatalf("upstream Host = %q, want %q", gotHost, upAddr)
	}
	if gotProto != "http" {
		t.Fatalf("X-Forwarded-Proto = %q", gotProto)
	}
	if gotXFF == "" {
		t.Fatalf("X-Forwarded-For missing")
	}
}

func TestProxyNoRoute(t *testing.T) {
	s := newTestServer(t, t.TempDir(), Route{Host: "app.example.com", Upstream: "x:80", TLS: "off"})
	rec := doReq(t, s.handler(false), "other.example.com", "/", false)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

func TestHTTPSRedirectWhenCertExists(t *testing.T) {
	s := newTestServer(t, t.TempDir(), Route{Host: "app.example.com", Upstream: "x:80", TLS: "acme"})
	// No cert loaded: no redirect, falls through to proxy (which
	// will 502 here, proving the redirect did not fire).
	rec := doReq(t, s.handler(false), "app.example.com", "/p", false)
	if rec.Code == http.StatusMovedPermanently {
		t.Fatalf("redirected without a cert")
	}
	// With a covering cert the request must redirect to https.
	der, key := selfSigned(t, []string{"app.example.com"}, days(90))
	if _, err := s.certs.persist("app.example.com", der, key); err != nil {
		t.Fatalf("persist: %v", err)
	}
	rec = doReq(t, s.handler(false), "app.example.com", "/p?q=1", false)
	if rec.Code != http.StatusMovedPermanently {
		t.Fatalf("expected 301, got %d", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != "https://app.example.com/p?q=1" {
		t.Fatalf("Location = %q", loc)
	}
}

func TestStaticServing(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "src", "app_s", "dist")
	write := func(rel, body string) {
		full := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("index.html", "<h1>hi</h1>")
	write("assets/app-3f2a1b9c.js", "js-body")
	write("style.css", "css-body")

	s := newTestServer(t, dir, Route{Host: "s.example.com", StaticRoot: "src/app_s/dist", TLS: "off"})
	h := s.handler(false)

	// index.html fallback on directory.
	rec := doReq(t, h, "s.example.com", "/", false)
	if rec.Code != 200 || rec.Body.String() != "<h1>hi</h1>" {
		t.Fatalf("index fallback: %d %q", rec.Code, rec.Body.String())
	}

	// Hashed asset under /assets/ gets immutable caching + etag.
	rec = doReq(t, h, "s.example.com", "/assets/app-3f2a1b9c.js", false)
	if rec.Code != 200 {
		t.Fatalf("asset: %d", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "public, max-age=31536000, immutable" {
		t.Fatalf("Cache-Control = %q", cc)
	}
	etag := rec.Header().Get("ETag")
	if etag == "" {
		t.Fatalf("ETag missing")
	}

	// Conditional revalidation answers 304.
	req := httptest.NewRequest(http.MethodGet, "http://s.example.com/assets/app-3f2a1b9c.js", nil)
	req.Host = "s.example.com"
	req.Header.Set("If-None-Match", etag)
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, req)
	if rec2.Code != http.StatusNotModified {
		t.Fatalf("expected 304, got %d", rec2.Code)
	}

	// Non-hashed file gets no-cache.
	rec = doReq(t, h, "s.example.com", "/style.css", false)
	if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("Cache-Control = %q", cc)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/css") {
		t.Fatalf("Content-Type = %q", ct)
	}

	// Traversal attempts get 404, never the file outside root.
	write("../secret.txt", "nope")
	for _, p := range []string{"/../secret.txt", "/%2e%2e/secret.txt", "/..\\secret.txt"} {
		rec = doReq(t, h, "s.example.com", p, false)
		if rec.Code != http.StatusNotFound || strings.Contains(rec.Body.String(), "nope") {
			t.Fatalf("traversal %q leaked: %d %q", p, rec.Code, rec.Body.String())
		}
	}
}

func TestChallengeInterception(t *testing.T) {
	s := newTestServer(t, t.TempDir(), Route{Host: "app.example.com", Upstream: "x:80", TLS: "acme"})
	h := s.handler(false)

	// A token this process issued gets its keyAuth.
	s.certs.addChallenge("tok-abc", "key-auth-value")
	rec := doReq(t, h, "app.example.com", "/.well-known/acme-challenge/tok-abc", false)
	if rec.Code != 200 || rec.Body.String() != "key-auth-value" {
		t.Fatalf("challenge: %d %q", rec.Code, rec.Body.String())
	}

	// Any other token is 404: the proxy must never echo attacker
	// input or forward challenge requests upstream.
	rec = doReq(t, h, "app.example.com", "/.well-known/acme-challenge/forged", false)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("forged token: %d", rec.Code)
	}
}

func TestStaticMissingAndOutsideRoot(t *testing.T) {
	s := newTestServer(t, t.TempDir(), Route{Host: "s.example.com", StaticRoot: "src/app_s/dist", TLS: "off"})
	rec := doReq(t, s.handler(false), "s.example.com", "/missing.txt", false)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

func TestHSTSOnTLS(t *testing.T) {
	s := newTestServer(t, t.TempDir(), Route{Host: "app.example.com", Upstream: "x:80", TLS: "off"})
	rec := doReq(t, s.handler(true), "app.example.com", "/", true)
	if h := rec.Header().Get("Strict-Transport-Security"); h == "" {
		t.Fatalf("HSTS missing on TLS response")
	}
}

// TestSignedGet verifies the agent's GET proof covers the request
// target bytes the hub reconstructs for proofGate.
func TestSignedGet(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var gotAuth, gotPub, gotProof, gotPath string
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("authorization")
		gotPub = r.Header.Get("x-agent-pubkey")
		gotProof = r.Header.Get("x-agent-proof")
		gotPath = r.URL.RequestURI()
		w.Write([]byte(`{"version":7,"routes":[{"host":"a.example.com","upstream":"a-rel:8080","appId":"a","tls":"acme"}]}`))
	}))
	defer hub.Close()

	c := NewClient(send.NewEndpoint(hub.URL), config.Config{Token: "tok", Timeout: 5e9}, priv)
	table, err := c.Routes(t.Context(), 42)
	if err != nil {
		t.Fatalf("Routes: %v", err)
	}
	if table.Version != 7 || len(table.Routes) != 1 {
		t.Fatalf("table: %+v", table)
	}
	if gotPath != "/ingress/routes?v=42" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotAuth != "Bearer tok" {
		t.Fatalf("authorization = %q", gotAuth)
	}
	pubRaw, _ := base64Decode(gotPub)
	if len(pubRaw) != 32 || string(pubRaw) != string(pub) {
		t.Fatalf("pubkey header mismatch")
	}
	sig, _ := base64Decode(gotProof)
	if !ed25519.Verify(pub, []byte("GET /ingress/routes?v=42"), sig) {
		t.Fatalf("proof does not cover request target")
	}
}

func TestRoutesNotModified(t *testing.T) {
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotModified)
	}))
	defer hub.Close()
	c := NewClient(send.NewEndpoint(hub.URL), config.Config{Token: "tok", Timeout: 5e9}, nil)
	table, err := c.Routes(t.Context(), 7)
	if err != nil || table != nil {
		t.Fatalf("304 should yield (nil, nil), got %v %v", table, err)
	}
}

func base64Decode(s string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(s)
}
