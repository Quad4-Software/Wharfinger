package edge

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func days(n int) time.Time { return time.Now().Add(time.Duration(n) * 24 * time.Hour) }

// selfSigned builds a throwaway cert chain for storage tests; no
// ACME directory is involved (a real handshake against a directory
// is out of scope for unit tests).
func selfSigned(t *testing.T, dns []string, notAfter time.Time) ([][]byte, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 62))
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: dns[0], Organization: []string{"edge-test"}},
		DNSNames:     dns,
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		Issuer:       pkix.Name{CommonName: "edge-test-ca"},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return [][]byte{der}, key
}

func newManager(t *testing.T) *CertManager {
	t.Helper()
	m, err := NewCertManager(t.TempDir(), "", nil, func(string) *Route { return nil })
	if err != nil {
		t.Fatalf("NewCertManager: %v", err)
	}
	return m
}

func TestCertPersistRoundTrip(t *testing.T) {
	dir := t.TempDir()
	m, err := NewCertManager(dir, "", nil, func(string) *Route { return nil })
	if err != nil {
		t.Fatal(err)
	}
	der, key := selfSigned(t, []string{"app.example.com"}, days(90))
	if _, err := m.persist("app.example.com", der, key); err != nil {
		t.Fatalf("persist: %v", err)
	}
	// File layout + permissions.
	for f, mode := range map[string]os.FileMode{
		"certs/app.example.com.pem": 0o644,
		"certs/app.example.com.key": 0o600,
	} {
		st, err := os.Stat(filepath.Join(dir, "edge", f))
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		if st.Mode().Perm() != mode {
			t.Fatalf("%s mode = %o, want %o", f, st.Mode().Perm(), mode)
		}
	}
	// A fresh manager loads what the first one wrote.
	m2, err := NewCertManager(dir, "", nil, func(string) *Route { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if !m2.covers("app.example.com") {
		t.Fatalf("reloaded cert does not cover host")
	}
	inv := m2.inventory()
	if len(inv) != 1 || inv[0].Host != "app.example.com" || inv[0].Status != "valid" {
		t.Fatalf("inventory: %+v", inv)
	}
	if inv[0].Issuer == "" || inv[0].ExpiresAt <= 0 {
		t.Fatalf("inventory fields empty: %+v", inv[0])
	}
}

func TestCertExpiryStatuses(t *testing.T) {
	m := newManager(t)
	for _, tc := range []struct {
		host   string
		expiry time.Time
		want   string
		covers bool
	}{
		{"valid.example.com", days(90), "valid", true},
		{"soon.example.com", days(10), "expiring", true},
		{"dead.example.com", days(-1), "expired", false},
	} {
		der, key := selfSigned(t, []string{tc.host}, tc.expiry)
		if _, err := m.persist(tc.host, der, key); err != nil {
			t.Fatal(err)
		}
		if got := m.covers(tc.host); got != tc.covers {
			t.Fatalf("covers(%s) = %v", tc.host, got)
		}
	}
	status := map[string]string{}
	for _, ci := range m.inventory() {
		status[ci.Host] = ci.Status
	}
	for _, tc := range []struct{ host, want string }{
		{"valid.example.com", "valid"},
		{"soon.example.com", "expiring"},
		{"dead.example.com", "expired"},
	} {
		if status[tc.host] != tc.want {
			t.Fatalf("status[%s] = %q, want %q", tc.host, status[tc.host], tc.want)
		}
	}
}

func TestWildcardCertCoversSubdomain(t *testing.T) {
	m := newManager(t)
	der, key := selfSigned(t, []string{"*.example.com"}, days(90))
	if _, err := m.persist("*.example.com", der, key); err != nil {
		t.Fatal(err)
	}
	if !m.covers("a.example.com") {
		t.Fatalf("wildcard cert does not cover a.example.com")
	}
	if m.covers("example.com") {
		t.Fatalf("wildcard cert must not cover apex")
	}
}

func TestChallengeStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	m, err := NewCertManager(dir, "", nil, func(string) *Route { return nil })
	if err != nil {
		t.Fatal(err)
	}
	m.addChallenge("tok1", "ka1")
	m2, err := NewCertManager(dir, "", nil, func(string) *Route { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if got := m2.challenge("tok1"); got != "ka1" {
		t.Fatalf("persisted challenge = %q", got)
	}
	m2.removeChallenge("tok1")
	if got := m2.challenge("tok1"); got != "" {
		t.Fatalf("removed challenge still present")
	}
}

func TestGetCertificateNoRoute(t *testing.T) {
	m := newManager(t)
	if _, err := m.GetCertificate(&tls.ClientHelloInfo{ServerName: "nope.example.com"}); err == nil {
		t.Fatalf("expected error for unmanaged host")
	}
}

func TestTLSConfigMinVersion(t *testing.T) {
	m := newManager(t)
	if cfg := m.tlsConfig(); cfg.MinVersion != tls.VersionTLS12 {
		t.Fatalf("MinVersion = %d", cfg.MinVersion)
	}
}
