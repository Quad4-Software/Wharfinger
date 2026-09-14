package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Hub-hosted manifest support: a wharfinger hub (or any static
// host) can serve a JSON manifest plus binaries, so agents on
// air-gapped networks update without reaching api.github.com. The
// manifest carries the sha256 per file; integrity is identical to
// the GitHub path because the digest is pinned before install.
//
// {"version":"1.2.3","files":[{"name":"wharfinger-agent-linux-amd64",
//   "version":"1.2.3","sha256":"<hex>","size":123,"url":"/api/agent-release/files/x"}]}

type manifestFile struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	SHA256  string `json:"sha256"`
	Size    int64  `json:"size"`
	URL     string `json:"url"`
}

type manifest struct {
	Version string         `json:"version"`
	Files   []manifestFile `json:"files"`
}

// ApplyManifest mirrors Apply but sources metadata and the binary
// from a manifest URL. insecure permits http:// URLs, matching the
// -insecure flag semantics for plaintext hub URLs.
func ApplyManifest(ctx context.Context, current, manifestURL string, insecure bool) (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return applyManifest(ctx, current, exe, manifestURL, insecure)
}

func applyManifest(ctx context.Context, current, exe, manifestURL string, insecure bool) (string, error) {
	exe, err := checkExe(exe)
	if err != nil {
		return "", err
	}
	m, base, err := fetchManifest(ctx, manifestURL, insecure)
	if err != nil {
		return "", err
	}
	var f *manifestFile
	for i := range m.Files {
		if m.Files[i].Name == binaryName() {
			f = &m.Files[i]
			break
		}
	}
	if f == nil {
		return "", fmt.Errorf("manifest has no %s asset", binaryName())
	}
	ver := f.Version
	if ver == "" {
		ver = m.Version
	}
	if !newerThan(ver, current) {
		return "", nil
	}
	dl, err := base.Parse(f.URL)
	if err != nil {
		return "", fmt.Errorf("bad file url %q: %w", f.URL, err)
	}
	bin, err := downloadScheme(ctx, dl.String(), maxBin, insecure)
	if err != nil {
		return "", fmt.Errorf("binary: %w", err)
	}
	sum := sha256.Sum256(bin)
	if got := hex.EncodeToString(sum[:]); !strings.EqualFold(got, f.SHA256) {
		return "", fmt.Errorf("checksum mismatch for %s", f.Name)
	}
	if err := install(exe, bin); err != nil {
		return "", err
	}
	return ver, nil
}

// fetchManifest GETs the manifest document and returns the parsed
// body plus its URL for resolving relative file links.
func fetchManifest(ctx context.Context, raw string, insecure bool) (*manifest, *url.URL, error) {
	base, err := url.Parse(raw)
	if err != nil {
		return nil, nil, err
	}
	if base.Scheme != "https" && !(insecure && base.Scheme == "http") {
		return nil, nil, fmt.Errorf("refusing non-https manifest URL")
	}
	rctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, http.MethodGet, base.String(), nil)
	if err != nil {
		return nil, nil, err
	}
	res, err := httpClient.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("manifest: %s", res.Status)
	}
	var m manifest
	if err := json.NewDecoder(io.LimitReader(res.Body, maxMeta)).Decode(&m); err != nil {
		return nil, nil, fmt.Errorf("manifest: %w", err)
	}
	return &m, res.Request.URL, nil
}

// downloadScheme is download with a scheme policy: https always,
// http only when the caller opted into plaintext (internal hubs).
func downloadScheme(ctx context.Context, raw string, max int64, insecure bool) ([]byte, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "https" && !(insecure && u.Scheme == "http") {
		return nil, fmt.Errorf("refusing non-https download URL")
	}
	return fetchURL(ctx, u.String(), max)
}
