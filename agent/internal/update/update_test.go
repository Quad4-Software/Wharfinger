package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestNewerThan(t *testing.T) {
	cases := []struct {
		tag, cur string
		want     bool
	}{
		{"v1.2.3", "1.2.2", true},
		{"v2.0.0", "1.9.9", true},
		{"1.2.3", "v1.2.2", true},
		{"v1.2.3", "1.2.3", false},  // same triple: not newer
		{"v1.2.3", "1.10.0", false}, // numeric, not lexical
		{"v1.2.3-rc1", "1.2.3", false},
		{"garbage", "1.0.0", false},
		{"v1.2.3", "dev", false},
	}
	for _, c := range cases {
		if got := newerThan(c.tag, c.cur); got != c.want {
			t.Errorf("newerThan(%q, %q) = %v, want %v", c.tag, c.cur, got, c.want)
		}
	}
}

func TestVerify(t *testing.T) {
	bin := []byte("release binary bytes")
	sum := sha256.Sum256(bin)
	name := "wharfinger-agent-linux-amd64"
	other := sha256.Sum256([]byte("arm64 binary bytes"))
	sums := fmt.Sprintf("%s  %s\n%s  wharfinger-agent-linux-arm64\n",
		hex.EncodeToString(sum[:]), name, hex.EncodeToString(other[:]))

	if err := verify(bin, []byte(sums), name); err != nil {
		t.Fatalf("good checksum rejected: %v", err)
	}
	if err := verify([]byte("tampered"), []byte(sums), name); err == nil {
		t.Fatal("checksum mismatch must abort")
	}
	if err := verify(bin, []byte(sums), "wharfinger-agent-linux-arm64"); err == nil {
		t.Fatal("mismatched name must abort")
	}
	if err := verify(bin, []byte("garbage\n"), name); err == nil {
		t.Fatal("missing sums entry must abort")
	}
}

func TestInstall(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "wharfinger-agent")
	if err := os.WriteFile(exe, []byte("old"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := install(exe, []byte("new-binary")); err != nil {
		t.Fatalf("install: %v", err)
	}
	b, err := os.ReadFile(exe)
	if err != nil || string(b) != "new-binary" {
		t.Fatalf("content after install: %q %v", b, err)
	}
	st, err := os.Stat(exe)
	if err != nil || st.Mode().Perm() != 0755 {
		t.Fatalf("mode after install: %v", st.Mode())
	}
	// Lock and staging file are cleaned up.
	for _, p := range []string{exe + ".update-lock", exe + ".new"} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("leftover %s", p)
		}
	}
}

func TestInstallRefusesNonRegular(t *testing.T) {
	if err := install(t.TempDir(), []byte("x")); err == nil {
		t.Fatal("install over a directory must fail")
	}
}

// stubRelease serves a fake GitHub releases API plus the two assets.
func stubRelease(t *testing.T, tag string, bin []byte) (*httptest.Server, string) {
	t.Helper()
	name := "wharfinger-agent-linux-" + runtime.GOARCH
	sum := sha256.Sum256(bin)
	mux := http.NewServeMux()
	var srv *httptest.Server
	mux.HandleFunc("/release", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": tag,
			"assets": []map[string]string{
				{"name": name, "browser_download_url": srv.URL + "/bin"},
				{"name": "SHA256SUMS.txt", "browser_download_url": srv.URL + "/sums"},
			},
		})
	})
	mux.HandleFunc("/bin", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(bin)
	})
	mux.HandleFunc("/sums", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "%s  %s\n", hex.EncodeToString(sum[:]), name)
	})
	srv = httptest.NewUnstartedServer(mux)
	srv.StartTLS()
	return srv, name
}

func TestApplyInstallsNewer(t *testing.T) {
	bin := []byte("new agent binary")
	srv, _ := stubRelease(t, "v9.9.9", bin)
	defer srv.Close()

	oldAPI, oldClient := releaseAPI, httpClient
	releaseAPI, httpClient = srv.URL+"/release", srv.Client()
	defer func() { releaseAPI, httpClient = oldAPI, oldClient }()

	exe := filepath.Join(t.TempDir(), "wharfinger-agent")
	if err := os.WriteFile(exe, []byte("old"), 0755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tag, err := apply(ctx, "0.1.0", exe)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if tag != "v9.9.9" {
		t.Fatalf("tag: %s", tag)
	}
	if b, _ := os.ReadFile(exe); string(b) != string(bin) {
		t.Fatal("binary not replaced")
	}
}

func TestApplySkipsSameVersion(t *testing.T) {
	srv, _ := stubRelease(t, "v0.1.0", []byte("x"))
	defer srv.Close()

	oldAPI, oldClient := releaseAPI, httpClient
	releaseAPI, httpClient = srv.URL+"/release", srv.Client()
	defer func() { releaseAPI, httpClient = oldAPI, oldClient }()

	exe := filepath.Join(t.TempDir(), "wharfinger-agent")
	if err := os.WriteFile(exe, []byte("old"), 0755); err != nil {
		t.Fatal(err)
	}
	tag, err := apply(context.Background(), "0.1.0", exe)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if tag != "" {
		t.Fatalf("same version must not update, got %s", tag)
	}
	if b, _ := os.ReadFile(exe); string(b) != "old" {
		t.Fatal("binary must be untouched")
	}
}
