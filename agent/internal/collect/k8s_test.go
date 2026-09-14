package collect

import (
	"os"
	"path/filepath"
	"testing"
)

func TestKubeletSecureClientFailsClosed(t *testing.T) {
	// No CA file and no insecure opt-out: collection is skipped.
	if c := kubeletSecureClient(); c != nil {
		t.Fatal("kubelet client must be nil without a CA file or insecure opt-out")
	}
	// Explicit opt-out returns a client.
	t.Setenv("WHARFINGER_KUBE_INSECURE", "1")
	if c := kubeletSecureClient(); c == nil {
		t.Fatal("WHARFINGER_KUBE_INSECURE=1 must return a client")
	}
}

func TestKubeletSecureClientMissingCAFallsBack(t *testing.T) {
	// A CA file that cannot be read must not silently drop
	// verification; it behaves like no CA at all.
	t.Setenv("WHARFINGER_KUBE_CA_FILE", filepath.Join(t.TempDir(), "missing.pem"))
	if c := kubeletSecureClient(); c != nil {
		t.Fatal("unreadable CA file must not produce a client")
	}
	t.Setenv("WHARFINGER_KUBE_INSECURE", "1")
	if c := kubeletSecureClient(); c == nil {
		t.Fatal("insecure opt-out must still work with a bad CA path")
	}
}

func TestKubeletSecureClientWithCA(t *testing.T) {
	pem := []byte("-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n")
	ca := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(ca, pem, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WHARFINGER_KUBE_CA_FILE", ca)
	// Empty PEM parses no certs: still fails closed.
	if c := kubeletSecureClient(); c != nil {
		t.Fatal("unparseable CA file must not produce a client")
	}
}
