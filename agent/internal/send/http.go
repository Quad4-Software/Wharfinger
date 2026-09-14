// Package send moves payloads to the hub. WebSocket is the primary
// transport; REST POST /ingress is the fallback when WS is unreachable
// (proxies that strip upgrades, dev servers).
package send

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/Quad4-Software/Wharfinger/agent/internal/collect"
	"github.com/Quad4-Software/Wharfinger/agent/internal/config"
)

// Shared client: keep-alive connections get reused across posts, and
// the per-request ctx carries the timeout instead.
var client = &http.Client{}

// PostSigned posts raw body bytes to a hub path with the standard
// agent auth: the bearer token plus, when id is non-nil, the
// x-agent-pubkey/x-agent-proof headers. The proof is an ed25519
// signature over the exact body bytes, which is why callers hand in
// serialized bytes instead of a value to marshal: reserializing
// would break verification. The response body is returned bounded.
func PostSigned(ctx context.Context, ep *Endpoint, cfg config.Config, id ed25519.PrivateKey, path string, body []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ep.HTTPBase()+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+cfg.Token)
	if id != nil {
		pub := id.Public().(ed25519.PublicKey)
		req.Header.Set("x-agent-pubkey", base64.StdEncoding.EncodeToString(pub))
		req.Header.Set("x-agent-proof", base64.StdEncoding.EncodeToString(ed25519.Sign(id, body)))
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	resp, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		msg := resp
		if len(msg) > 512 {
			msg = msg[:512]
		}
		return nil, fmt.Errorf("%s rejected: %s %s", path, res.Status, strings.TrimSpace(string(msg)))
	}
	return resp, nil
}

// PostREST sends one payload over the REST ingress. Used both as the
// WS fallback and by the --once debug path. The effective URL comes
// from ep so an observed TLS redirect applies here too. It returns
// the pending job count the hub piggybacks on the metrics response,
// or -1 when the response carried none (older hubs, ws path).
func PostREST(ctx context.Context, ep *Endpoint, cfg config.Config, id ed25519.PrivateKey, p *collect.Payload) (int, error) {
	body, err := json.Marshal(p)
	if err != nil {
		return -1, err
	}
	resp, err := PostSigned(ctx, ep, cfg, id, "/ingress", body)
	if err != nil {
		return -1, err
	}
	var ack struct {
		Pending *int `json:"pending"`
	}
	if err := json.Unmarshal(resp, &ack); err == nil && ack.Pending != nil {
		return *ack.Pending, nil
	}
	return -1, nil
}

// PostOnce is a convenience wrapper with its own timeout context.
func PostOnce(ep *Endpoint, cfg config.Config, id ed25519.PrivateKey, p *collect.Payload) (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), cfg.Timeout)
	defer cancel()
	return PostREST(ctx, ep, cfg, id, p)
}
