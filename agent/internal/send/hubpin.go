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
	"sync"

	"github.com/Quad4-Software/Wharfinger/agent/internal/config"
	"github.com/Quad4-Software/Wharfinger/agent/internal/state"
)

// pubkeyResponse mirrors GET /ingress/pubkey on the hub. pub is the
// current hub ed25519 public key (base64 raw 32 bytes). prev_pub,
// rotated_at, and proof appear after a rotation: proof is an ed25519
// signature made by the PREVIOUS private key over the new raw pubkey
// bytes, which is what lets a pinned agent adopt the new key without
// trusting the network.
type pubkeyResponse struct {
	Pub       string `json:"pub"`
	PrevPub   string `json:"prev_pub,omitempty"`
	RotatedAt int64  `json:"rotated_at,omitempty"`
	Proof     string `json:"proof,omitempty"`
}

// decideAdopt is the rotation policy, kept pure for tests. It returns
// the key the agent should pin going forward and whether that is a
// change from the current pin (nil pinned means first contact: adopt
// whatever the hub advertises, classic TOFU).
func decideAdopt(pinned ed25519.PublicKey, r pubkeyResponse) (ed25519.PublicKey, bool, error) {
	pub, err := base64.StdEncoding.DecodeString(r.Pub)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return nil, false, fmt.Errorf("hub pubkey endpoint returned an invalid key")
	}
	if pinned == nil {
		return ed25519.PublicKey(pub), true, nil
	}
	if bytes.Equal(pinned, pub) {
		return pinned, false, nil
	}
	if r.Proof == "" {
		return nil, false, fmt.Errorf("hub key changed but no rotation proof was provided")
	}
	proof, err := base64.StdEncoding.DecodeString(r.Proof)
	if err != nil || !ed25519.Verify(pinned, pub, proof) {
		return nil, false, fmt.Errorf("hub key rotation proof is invalid")
	}
	return ed25519.PublicKey(pub), true, nil
}

// fetchPubkey reads GET /ingress/pubkey from the effective hub URL.
// The caller's context carries the timeout.
func fetchPubkey(ctx context.Context, ep *Endpoint) (pubkeyResponse, error) {
	var out pubkeyResponse
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ep.HTTPBase()+"/ingress/pubkey", nil)
	if err != nil {
		return out, err
	}
	res, err := client.Do(req)
	if err != nil {
		return out, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return out, fmt.Errorf("pubkey endpoint: %s", res.Status)
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 8<<10)).Decode(&out); err != nil {
		return out, fmt.Errorf("pubkey endpoint: bad json: %w", err)
	}
	return out, nil
}

// HubPin tracks which hub public key the agent trusts. An explicitly
// configured KEY always wins and rewrites the persisted pin; without
// one the persisted hub.key file is the pin, and without either the
// first connection adopts what the hub advertises (TOFU).
type HubPin struct {
	mu    sync.Mutex
	store *state.Store // nil disables persistence
	key   ed25519.PublicKey
}

// NewHubPin resolves the effective pin: cfg.HubKey when configured
// (re-seeding the file when it differs), else the stored file, else
// nil for TOFU on first connect.
func NewHubPin(cfg config.Config, store *state.Store) (*HubPin, error) {
	p := &HubPin{store: store}
	if cfg.HubKey != "" {
		pub, err := base64.StdEncoding.DecodeString(cfg.HubKey)
		if err != nil || len(pub) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("invalid hub public key (KEY): want base64 raw 32 bytes")
		}
		p.key = ed25519.PublicKey(pub)
		if store != nil {
			stored, err := store.HubPin()
			if err != nil {
				return nil, err
			}
			if !bytes.Equal(stored, p.key) {
				if err := store.SaveHubPin(p.key); err != nil {
					return nil, err
				}
			}
		}
		return p, nil
	}
	if store != nil {
		stored, err := store.HubPin()
		if err != nil {
			return nil, err
		}
		p.key = stored
	}
	return p, nil
}

// Current returns the pinned key, or nil before TOFU adoption.
func (p *HubPin) Current() ed25519.PublicKey {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.key
}

// adopt installs a new pin in memory and on disk.
func (p *HubPin) adopt(pub ed25519.PublicKey) error {
	p.mu.Lock()
	p.key = pub
	p.mu.Unlock()
	if p.store != nil {
		return p.store.SaveHubPin(pub)
	}
	return nil
}
