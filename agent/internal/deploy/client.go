package deploy

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"

	"github.com/Quad4-Software/Wharfinger/agent/internal/config"
	"github.com/Quad4-Software/Wharfinger/agent/internal/send"
)

// Job is one claimed job from the hub queue. Spec is a frozen JSON
// string parsed per kind.
type Job struct {
	ID         int64  `json:"id"`
	Kind       string `json:"kind"`
	Spec       string `json:"spec"`
	Lease      string `json:"lease"`
	LeaseUntil int64  `json:"leaseUntil"`
	Attempt    int    `json:"attempt"`
}

// ReconcileItem is one observed outcome reported at startup for a
// job the hub marked unknown.
type ReconcileItem struct {
	ID      int64  `json:"id"`
	Outcome string `json:"outcome"` // succeeded | failed | rolled_back
	Result  any    `json:"result,omitempty"`
}

// Client talks to the hub job endpoints. Bodies go through
// send.PostSigned so the bearer token and the ed25519 proof headers
// cover the exact request bytes, same as metrics posts.
type Client struct {
	ep  *send.Endpoint
	cfg config.Config
	id  ed25519.PrivateKey
}

func NewClient(ep *send.Endpoint, cfg config.Config, id ed25519.PrivateKey) *Client {
	return &Client{ep: ep, cfg: cfg, id: id}
}

func (c *Client) post(ctx context.Context, path string, body any) ([]byte, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, c.cfg.Timeout)
	defer cancel()
	return send.PostSigned(cctx, c.ep, c.cfg, c.id, path, raw)
}

// Claim asks the hub for the next job. A nil job means the queue is
// empty for this agent. Deploys list first so a queued deploy always
// drains before a teardown for the same app.
func (c *Client) Claim(ctx context.Context) (*Job, error) {
	res, err := c.post(ctx, "/ingress/jobs/claim", map[string]any{
		"kinds": []string{"deploy", "teardown"},
	})
	if err != nil {
		return nil, err
	}
	var out struct {
		Job *Job `json:"job"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		return nil, fmt.Errorf("claim: bad response: %w", err)
	}
	return out.Job, nil
}

// Action posts one lifecycle transition for a job. It returns false
// when the hub rejected the lease: another attempt owns the job now,
// and continuing locally could race it.
func (c *Client) Action(ctx context.Context, jobID int64, lease, action, chunk string, result any) (bool, error) {
	body := map[string]any{"lease": lease, "action": action}
	if chunk != "" {
		body["chunk"] = chunk
	}
	if result != nil {
		body["result"] = result
	}
	res, err := c.post(ctx, fmt.Sprintf("/ingress/jobs/%d", jobID), body)
	if err != nil {
		return false, err
	}
	var out struct {
		Ok     bool   `json:"ok"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		return false, fmt.Errorf("job action: bad response: %w", err)
	}
	// fail/rolled_back answer with a status word instead of ok.
	return out.Ok || out.Status != "", nil
}

// Secrets is the material a claimed deploy job needs: the app's
// env map and, when one exists, the deploy private key as base64
// raw ed25519 (seed + public half, 64 bytes).
type Secrets struct {
	Env       map[string]string
	DeployKey []byte
}

// Secrets fetches the app's sealed env map and deploy key for a
// claimed deploy job. The hub only answers the live lease holder.
func (c *Client) Secrets(ctx context.Context, jobID int64, lease string) (*Secrets, error) {
	res, err := c.post(ctx, fmt.Sprintf("/ingress/jobs/%d/secrets", jobID), map[string]any{
		"lease": lease,
	})
	if err != nil {
		return nil, err
	}
	var out struct {
		Env       map[string]string `json:"env"`
		DeployKey *struct {
			Priv string `json:"priv"`
		} `json:"deployKey"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		return nil, fmt.Errorf("secrets: bad response: %w", err)
	}
	if out.Env == nil {
		return nil, fmt.Errorf("secrets: %s", out.Error)
	}
	sec := &Secrets{Env: out.Env}
	if out.DeployKey != nil && out.DeployKey.Priv != "" {
		raw, err := base64.StdEncoding.DecodeString(out.DeployKey.Priv)
		if err != nil || len(raw) != ed25519.PrivateKeySize {
			return nil, fmt.Errorf("secrets: malformed deploy key")
		}
		sec.DeployKey = raw
	}
	return sec, nil
}

// Reconcile posts observed outcomes for jobs whose lease the hub
// lost track of.
func (c *Client) Reconcile(ctx context.Context, items []ReconcileItem) error {
	if len(items) == 0 {
		return nil
	}
	res, err := c.post(ctx, "/ingress/jobs/reconcile", map[string]any{"jobs": items})
	if err != nil {
		return err
	}
	var out struct {
		Ok bool `json:"ok"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		return fmt.Errorf("reconcile: bad response: %w", err)
	}
	return nil
}
