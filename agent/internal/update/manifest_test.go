package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// stubManifest serves a hub-style manifest plus the binary file.
func stubManifest(t *testing.T, version string, bin []byte) *httptest.Server {
	t.Helper()
	name := "wharfinger-agent-linux-" + runtime.GOARCH
	sum := sha256.Sum256(bin)
	mux := http.NewServeMux()
	var srv *httptest.Server
	mux.HandleFunc("/manifest", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"version": version,
			"files": []map[string]any{
				{
					"name":    name,
					"version": version,
					"sha256":  hex.EncodeToString(sum[:]),
					"size":    len(bin),
					// Relative URL: resolved against the manifest URL.
					"url": "/files/" + name,
				},
			},
		})
	})
	mux.HandleFunc("/files/"+name, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(bin)
	})
	srv = httptest.NewUnstartedServer(mux)
	srv.StartTLS()
	return srv
}

func TestApplyManifestInstallsNewer(t *testing.T) {
	bin := []byte("manifest agent binary")
	srv := stubManifest(t, "9.9.9", bin)
	defer srv.Close()

	old := httpClient
	httpClient = srv.Client()
	defer func() { httpClient = old }()

	exe := filepath.Join(t.TempDir(), "wharfinger-agent")
	if err := os.WriteFile(exe, []byte("old"), 0755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ver, err := applyManifest(ctx, "0.1.0", exe, srv.URL+"/manifest", false)
	if err != nil {
		t.Fatalf("applyManifest: %v", err)
	}
	if ver != "9.9.9" {
		t.Fatalf("version: %s", ver)
	}
	if b, _ := os.ReadFile(exe); string(b) != string(bin) {
		t.Fatal("binary not replaced")
	}
}

func TestApplyManifestSkipsSameVersion(t *testing.T) {
	srv := stubManifest(t, "0.1.0", []byte("x"))
	defer srv.Close()

	old := httpClient
	httpClient = srv.Client()
	defer func() { httpClient = old }()

	exe := filepath.Join(t.TempDir(), "wharfinger-agent")
	if err := os.WriteFile(exe, []byte("old"), 0755); err != nil {
		t.Fatal(err)
	}
	ver, err := applyManifest(context.Background(), "0.1.0", exe, srv.URL+"/manifest", false)
	if err != nil {
		t.Fatalf("applyManifest: %v", err)
	}
	if ver != "" {
		t.Fatalf("same version must not update, got %s", ver)
	}
}

func TestApplyManifestRejectsBadChecksum(t *testing.T) {
	srv := stubManifest(t, "9.9.9", []byte("real"))
	defer srv.Close()

	old := httpClient
	httpClient = srv.Client()
	defer func() { httpClient = old }()

	exe := filepath.Join(t.TempDir(), "wharfinger-agent")
	if err := os.WriteFile(exe, []byte("old"), 0755); err != nil {
		t.Fatal(err)
	}
	// Swap the file bytes after the manifest digest was computed by
	// serving different content than the digest covers.
	real := sha256.Sum256([]byte("real"))
	mux := http.NewServeMux()
	mux.HandleFunc("/manifest", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"version": "9.9.9",
			"files": []map[string]any{
				{"name": "wharfinger-agent-linux-" + runtime.GOARCH, "version": "9.9.9",
					"sha256": hex.EncodeToString(real[:]), "url": "/f"},
			},
		})
	})
	mux.HandleFunc("/f", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("tampered")) })
	evil := httptest.NewTLSServer(mux)
	defer evil.Close()

	httpClient = evil.Client()
	_, err := applyManifest(context.Background(), "0.1.0", exe, evil.URL+"/manifest", false)
	if err == nil {
		t.Fatal("checksum mismatch must abort")
	}
	if b, _ := os.ReadFile(exe); string(b) != "old" {
		t.Fatal("binary must be untouched")
	}
}
