package send

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// redirectHub serves the plaintext side of a TLS-terminating proxy:
// every request redirects to the same path on target.
func redirectHub(t *testing.T, target func(*http.Request) string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target(r), http.StatusMovedPermanently)
	}))
}

func TestEndpointTLSUpgrade(t *testing.T) {
	tlsSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("pubkey"))
	}))
	defer tlsSrv.Close()

	old := probeTransport
	probeTransport = tlsSrv.Client().Transport
	defer func() { probeTransport = old }()

	plain := redirectHub(t, func(r *http.Request) string {
		return tlsSrv.URL + r.URL.Path
	})
	defer plain.Close()

	ep := NewEndpoint(plain.URL + "/status")
	base := ep.Base()
	if want := tlsSrv.URL + "/status"; base != want {
		t.Fatalf("base: got %s want %s", base, want)
	}
	ws, err := ep.WSURL()
	if err != nil {
		t.Fatal(err)
	}
	if want := "wss://" + strings.TrimPrefix(tlsSrv.URL, "https://") + "/status/ingress/ws"; ws != want {
		t.Fatalf("ws url: got %s want %s", ws, want)
	}
}

func TestEndpointRefusesCrossHostRedirect(t *testing.T) {
	plain := redirectHub(t, func(r *http.Request) string {
		return "https://example.invalid" + r.URL.Path
	})
	defer plain.Close()

	ep := NewEndpoint(plain.URL)
	if base := ep.Base(); base != plain.URL {
		t.Fatalf("cross-host redirect should not upgrade: %s", base)
	}
	ws, err := ep.WSURL()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(ws, "ws://") {
		t.Fatalf("expected ws scheme, got %s", ws)
	}
}

func TestEndpointStaysPlainWithoutRedirect(t *testing.T) {
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("pubkey"))
	}))
	defer plain.Close()

	ep := NewEndpoint(plain.URL)
	if base := ep.Base(); base != plain.URL {
		t.Fatalf("no redirect should keep the base: %s", base)
	}
}

func TestEndpointNeverProbesTLS(t *testing.T) {
	ep := NewEndpoint("https://status.example.com")
	if base := ep.Base(); base != "https://status.example.com" {
		t.Fatalf("https base must pass through untouched: %s", base)
	}
	ws, err := ep.WSURL()
	if err != nil {
		t.Fatal(err)
	}
	if ws != "wss://status.example.com/ingress/ws" {
		t.Fatalf("ws url: %s", ws)
	}
}

func TestEndpointRefusesPathRewrite(t *testing.T) {
	tlsSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))
	defer tlsSrv.Close()

	old := probeTransport
	probeTransport = tlsSrv.Client().Transport
	defer func() { probeTransport = old }()

	// Redirect lands on a different path: ambiguous, stay plaintext.
	plain := redirectHub(t, func(r *http.Request) string {
		return tlsSrv.URL + "/elsewhere"
	})
	defer plain.Close()

	ep := NewEndpoint(plain.URL)
	if base := ep.Base(); base != plain.URL {
		t.Fatalf("path-rewriting redirect should not upgrade: %s", base)
	}
}
