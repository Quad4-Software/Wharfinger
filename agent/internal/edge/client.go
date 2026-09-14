package edge

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/Quad4-Software/Wharfinger/agent/internal/config"
	"github.com/Quad4-Software/Wharfinger/agent/internal/send"
)

// Client talks to the hub route-table endpoint. Like send.PostSigned
// it carries the bearer token plus the x-agent-pubkey/x-agent-proof
// headers. GETs have no body, so the proof signs the request target
// "GET <path><query>"; the hub route feeds the same bytes to its
// proofGate, which means the ?v= stamp is proof-covered too.
type Client struct {
	ep  *send.Endpoint
	cfg config.Config
	id  ed25519.PrivateKey
	hc  *http.Client
}

func NewClient(ep *send.Endpoint, cfg config.Config, id ed25519.PrivateKey) *Client {
	return &Client{ep: ep, cfg: cfg, id: id, hc: &http.Client{}}
}

func (c *Client) getSigned(ctx context.Context, path string) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.ep.HTTPBase()+path, nil)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("authorization", "Bearer "+c.cfg.Token)
	if c.id != nil {
		msg := []byte("GET " + path)
		pub := c.id.Public().(ed25519.PublicKey)
		req.Header.Set("x-agent-pubkey", base64.StdEncoding.EncodeToString(pub))
		req.Header.Set("x-agent-proof", base64.StdEncoding.EncodeToString(ed25519.Sign(c.id, msg)))
	}
	res, err := c.hc.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	resp, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	return res.StatusCode, resp, nil
}

// Routes fetches the route table for this agent. seen is the last
// applied version; the hub answers 304 when it is unchanged, in
// which case Routes returns (nil, nil). Any other non-2xx is an
// error carrying the bounded response text, matching PostSigned.
func (c *Client) Routes(ctx context.Context, seen int64) (*RouteTable, error) {
	cctx, cancel := context.WithTimeout(ctx, c.cfg.Timeout)
	defer cancel()
	path := "/ingress/routes"
	if seen > 0 {
		path = fmt.Sprintf("%s?v=%d", path, seen)
	}
	status, resp, err := c.getSigned(cctx, path)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotModified {
		return nil, nil
	}
	if status < 200 || status >= 300 {
		msg := resp
		if len(msg) > 512 {
			msg = msg[:512]
		}
		return nil, fmt.Errorf("routes rejected: %d %s", status, strings.TrimSpace(string(msg)))
	}
	var table RouteTable
	if err := json.Unmarshal(resp, &table); err != nil {
		return nil, fmt.Errorf("routes: bad response: %w", err)
	}
	if err := table.validate(); err != nil {
		return nil, fmt.Errorf("routes: %w", err)
	}
	return &table, nil
}

// validate applies the same caps the hub enforces, so a corrupt or
// hostile table can never reach the proxy.
func (t *RouteTable) validate() error {
	if len(t.Routes) > maxRoutes {
		return fmt.Errorf("too many routes: %d", len(t.Routes))
	}
	for i := range t.Routes {
		r := &t.Routes[i]
		if !hostRe.MatchString(r.Host) || len(r.Host) > 253 {
			return fmt.Errorf("invalid route host %q", r.Host)
		}
		switch r.TLS {
		case "acme", "manual", "off":
		default:
			return fmt.Errorf("invalid tls mode %q", r.TLS)
		}
		if r.StaticRoot != "" {
			if !safeRelPath(r.StaticRoot) {
				return fmt.Errorf("invalid staticRoot %q", r.StaticRoot)
			}
			continue
		}
		if !upstreamRe.MatchString(r.Upstream) {
			return fmt.Errorf("invalid upstream %q", r.Upstream)
		}
		var port int
		if _, err := fmt.Sscanf(r.Upstream[strings.LastIndex(r.Upstream, ":")+1:], "%d", &port); err != nil || port < 1 || port > 65535 {
			return fmt.Errorf("invalid upstream port %q", r.Upstream)
		}
	}
	return nil
}
