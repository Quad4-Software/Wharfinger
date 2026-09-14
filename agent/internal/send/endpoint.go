package send

import (
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// probeTransport is a var so tests can trust a stub TLS server.
var probeTransport = http.DefaultTransport

// Endpoint resolves the effective hub base URL. When the hub is
// configured over plaintext and a one-time probe shows it redirects
// to https on the same host, the scheme is upgraded for the rest of
// the process lifetime: REST posts go over https and the ws dial
// uses wss. The upgrade is strictly one-way: redirects to another
// host or back to plaintext are ignored, so a misconfigured or
// hostile middlebox cannot steer or downgrade the transport.
type Endpoint struct {
	mu     sync.Mutex
	base   string // effective hub base URL, no trailing slash
	probed bool   // probe finished with a definitive HTTP answer
}

// NewEndpoint returns an Endpoint for the configured hub base URL.
func NewEndpoint(base string) *Endpoint {
	return &Endpoint{base: strings.TrimRight(base, "/")}
}

// Base returns the effective hub base URL, running the TLS upgrade
// probe once when the scheme is plaintext.
func (e *Endpoint) Base() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.probeLocked()
	return e.base
}

// WSURL returns the websocket URL for the effective base: https maps
// to wss, anything else to ws.
func (e *Endpoint) WSURL() (string, error) {
	u, err := url.Parse(e.Base() + "/ingress/ws")
	if err != nil {
		return "", err
	}
	if u.Scheme == "https" || u.Scheme == "wss" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	return u.String(), nil
}

// HTTPBase returns the effective base with a plain http(s) scheme.
// Plain REST calls (pubkey fetch, metrics posts) need it when the hub
// was configured with a ws:// or wss:// URL.
func (e *Endpoint) HTTPBase() string {
	b := e.Base()
	if strings.HasPrefix(b, "wss://") {
		return "https://" + strings.TrimPrefix(b, "wss://")
	}
	if strings.HasPrefix(b, "ws://") {
		return "http://" + strings.TrimPrefix(b, "ws://")
	}
	return b
}

// probeLocked does a one-time GET on /ingress/pubkey that follows a
// single redirect hop. When the hop lands on https with the same
// hostname the base URL is rewritten to https. Only an actual HTTP
// response latches probed; a transport error retries on the next
// call, which costs at most one extra GET per delivery attempt while
// the hub is unreachable.
func (e *Endpoint) probeLocked() {
	if e.probed {
		return
	}
	u, err := url.Parse(e.base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "ws") {
		e.probed = true // already TLS, or unparseable: nothing to do
		return
	}
	origHost := u.Hostname()
	probe := *u
	probe.Scheme = "http"
	probe.Path = strings.TrimRight(probe.Path, "/") + "/ingress/pubkey"
	probe.RawQuery = ""

	var hopOK bool
	c := &http.Client{
		Timeout:   10 * time.Second,
		Transport: probeTransport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			// via holds the requests already made, so len(via) > 1
			// means a second hop: refuse it. The first hop is
			// allowed only onto https with the same hostname.
			if len(via) > 1 || req.URL.Scheme != "https" ||
				!strings.EqualFold(req.URL.Hostname(), origHost) {
				return http.ErrUseLastResponse
			}
			hopOK = true
			return nil
		},
	}
	res, err := c.Get(probe.String())
	if err != nil {
		return // unreachable hub or untrusted cert: retry next call
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4<<10))
	res.Body.Close()
	e.probed = true

	final := res.Request.URL
	if !hopOK || final.Scheme != "https" {
		return
	}
	// A plain TLS redirect preserves the request path; a redirect
	// that also rewrote the path is ambiguous, so stay on the
	// configured scheme rather than guess a new mount point.
	newPath, ok := strings.CutSuffix(final.Path, "/ingress/pubkey")
	if !ok {
		return
	}
	e.base = "https://" + final.Host + newPath
	log.Printf("hub redirect: upgraded base URL to %s", e.base)
}

// PlaintextWarn logs once when the effective hub URL is not TLS. The
// bearer token and every payload then travel unencrypted; it exists
// to make a misconfigured -insecure deployment loud.
func (e *Endpoint) PlaintextWarn() {
	if strings.HasPrefix(e.Base(), "http://") || strings.HasPrefix(e.Base(), "ws://") {
		log.Printf("WARNING: hub URL %s is plaintext; the agent token and all metrics are sent unencrypted", e.Base())
	}
}
