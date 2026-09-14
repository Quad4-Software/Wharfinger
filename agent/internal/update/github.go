package update

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// releaseAPI and httpClient are vars so tests can point at a stub
// server and its trusted transport.
var releaseAPI = "https://api.github.com/repos/Quad4-Software/Wharfinger/releases/latest"

var httpClient = &http.Client{CheckRedirect: httpsOnlyRedirect}

// Size bounds: release JSON and SHA256SUMS.txt are small; the binary
// bound is generous headroom over the ~10 MiB release asset.
const (
	maxMeta = 1 << 20
	maxSums = 64 << 10
	maxBin  = 64 << 20
)

// httpsOnlyRedirect allows redirect chains (GitHub serves release
// assets from a CDN behind redirects) but every hop must stay on
// https so a redirect can never silently drop to plaintext.
func httpsOnlyRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= 5 {
		return fmt.Errorf("too many redirects")
	}
	if req.URL.Scheme != "https" {
		return fmt.Errorf("refusing %s redirect", req.URL.Scheme)
	}
	return nil
}

type release struct {
	TagName string `json:"tag_name"`
	Assets  []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}

// latest fetches the newest release metadata from GitHub.
func latest(ctx context.Context) (*release, error) {
	rctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, http.MethodGet, releaseAPI, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("github releases: %s", res.Status)
	}
	var rel release
	if err := json.NewDecoder(io.LimitReader(res.Body, maxMeta)).Decode(&rel); err != nil {
		return nil, fmt.Errorf("github releases: %w", err)
	}
	return &rel, nil
}

// download fetches a release asset. The URL itself must be https;
// redirects stay https via httpsOnlyRedirect.
func download(ctx context.Context, raw string, max int64) ([]byte, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" {
		return nil, fmt.Errorf("refusing non-https download URL")
	}
	return fetchURL(ctx, u.String(), max)
}

// fetchURL GETs an already scheme-validated URL with a body cap.
func fetchURL(ctx context.Context, raw string, max int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, err
	}
	res, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download: %s", res.Status)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, fmt.Errorf("download exceeds %d bytes", max)
	}
	return b, nil
}
