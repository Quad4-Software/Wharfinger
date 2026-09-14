package send

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/Quad4-Software/Wharfinger/agent/internal/collect"
	"github.com/Quad4-Software/Wharfinger/agent/internal/config"
)

// Wire messages mirror the hub side in server/ingress-ws.mjs. The
// handshake follows the Beszel model, extended with proof of
// possession: bearer token on upgrade, hub proves itself by signing
// the token and issues a per-connection nonce, the agent proves its
// identity key by signing that nonce before any data flows.
type wsChallenge struct {
	Type      string `json:"type"`
	Signature string `json:"signature"`
	Nonce     string `json:"nonce"`
}

type wsHello struct {
	Type        string `json:"type"`
	Fingerprint string `json:"fingerprint"`
	V           int    `json:"v"`
	Pubkey      string `json:"pubkey,omitempty"`
	Proof       string `json:"proof,omitempty"`
}

// metrics frames carry the payload as a JSON string, not an object:
// the proof is an ed25519 signature over those exact bytes, and the
// hub verifies it against the raw request body the bridge forwards.
// Legacy hubs (no nonce in the challenge) get the object form.
type wsMetrics struct {
	Type   string `json:"type"`
	Data   string `json:"data"`
	Pubkey string `json:"pubkey,omitempty"`
	Proof  string `json:"proof,omitempty"`
}

type wsMetricsLegacy struct {
	Type string           `json:"type"`
	Data *collect.Payload `json:"data"`
}

// errBadHubSig marks a challenge signature that does not verify under
// the pinned key. It is the only failure that triggers the key
// rotation check before the handshake is retried once.
var errBadHubSig = errors.New("hub signature verification failed")

// PingInterval is the keepalive cadence the main loop pings on. The
// read deadline is two intervals: a hub that misses one pong gets a
// grace window, and one that misses two is declared dead so the
// agent reconnects.
const PingInterval = 30 * time.Second

// WSClient owns one websocket connection plus the reconnect policy.
type WSClient struct {
	cfg config.Config
	ep  *Endpoint
	id  ed25519.PrivateKey
	pin *HubPin

	mu        sync.Mutex
	c         *websocket.Conn
	legacyHub bool // peer spoke the pre-nonce protocol
}

func NewWSClient(cfg config.Config, ep *Endpoint, id ed25519.PrivateKey, pin *HubPin) *WSClient {
	if pin == nil {
		pin = &HubPin{}
	}
	return &WSClient{cfg: cfg, ep: ep, id: id, pin: pin}
}

// Connected reports whether the link is up. Safe for polling.
func (w *WSClient) Connected() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.c != nil
}

// Connect performs the full handshake and leaves the client ready to
// Send. When the challenge signature fails under the pinned key the
// client fetches /ingress/pubkey once: a valid rotation proof (signed
// by the previous hub key) adopts the new key and retries the
// handshake exactly once; anything else is a hard failure because a
// bad signature with no proof is indistinguishable from a MITM.
func (w *WSClient) Connect(ctx context.Context, fp string) error {
	err := w.handshake(ctx, fp)
	if !errors.Is(err, errBadHubSig) {
		return err
	}
	adopted, rerr := w.tryRotation(ctx)
	if rerr != nil {
		return rerr
	}
	if !adopted {
		return err
	}
	return w.handshake(ctx, fp)
}

// handshake runs one dial plus challenge/hello/ready exchange.
func (w *WSClient) handshake(ctx context.Context, fp string) error {
	raw, err := w.ep.WSURL()
	if err != nil {
		return err
	}
	d := websocket.Dialer{HandshakeTimeout: w.cfg.Timeout}
	hdr := http.Header{
		"authorization":   {"Bearer " + w.cfg.Token},
		"x-agent-version": {collect.AgentVersion},
	}
	c, _, err := d.DialContext(ctx, raw, hdr)
	if err != nil {
		return fmt.Errorf("ws dial: %w", err)
	}
	fail := func(e error) error {
		c.Close()
		return e
	}

	// 1. Hub challenge: signature over the token proves hub identity,
	// the nonce is the per-connection proof-of-possession input.
	var ch wsChallenge
	if err := c.ReadJSON(&ch); err != nil {
		return fail(fmt.Errorf("ws challenge: %w", err))
	}
	if ch.Type != "challenge" {
		return fail(fmt.Errorf("ws handshake: unexpected %q", ch.Type))
	}
	if err := w.verifyHub(ctx, ch.Signature); err != nil {
		return fail(err)
	}

	// 2. Identify with the machine fingerprint and, when the hub
	// issued a nonce, prove the identity key by signing it. A hub that
	// sends no nonce is the pre-proof protocol: speak the object
	// frame format it understands (recomputed per connect so a hub
	// upgrade mid-process takes effect on the next reconnect).
	w.mu.Lock()
	w.legacyHub = ch.Nonce == ""
	w.mu.Unlock()
	hello := wsHello{Type: "hello", Fingerprint: fp, V: 1}
	if ch.Nonce != "" && w.id != nil {
		nonce, err := base64.StdEncoding.DecodeString(ch.Nonce)
		if err != nil {
			return fail(fmt.Errorf("ws handshake: bad challenge nonce"))
		}
		pub := w.id.Public().(ed25519.PublicKey)
		hello.Pubkey = base64.StdEncoding.EncodeToString(pub)
		hello.Proof = base64.StdEncoding.EncodeToString(ed25519.Sign(w.id, nonce))
	}
	if err := c.WriteJSON(hello); err != nil {
		return fail(fmt.Errorf("ws hello: %w", err))
	}
	var ready struct {
		Type  string `json:"type"`
		Error string `json:"error"`
	}
	if err := c.ReadJSON(&ready); err != nil {
		return fail(fmt.Errorf("ws ready: %w", err))
	}
	if ready.Type != "ready" {
		if ready.Error != "" {
			return fail(fmt.Errorf("ws rejected: %s", ready.Error))
		}
		return fail(fmt.Errorf("ws handshake: unexpected %q", ready.Type))
	}

	w.mu.Lock()
	w.c = c
	w.mu.Unlock()

	// Read pump: keeps the deadline alive and notices closes. Writes
	// happen on the caller goroutine under mu.
	go w.readLoop(c)
	return nil
}

// verifyHub checks the hub's ed25519 signature over the token against
// the pinned key. With no pin (no KEY configured, no state file) the
// agent is on first contact: it fetches /ingress/pubkey and adopts it
// by TOFU, so that first connection must happen on a trusted network.
func (w *WSClient) verifyHub(ctx context.Context, sigB64 string) error {
	pub := w.pin.Current()
	if pub == nil {
		r, err := fetchPubkey(ctx, w.ep)
		if err != nil {
			return fmt.Errorf("hub key fetch (TOFU): %w", err)
		}
		newPub, adopted, err := decideAdopt(nil, r)
		if err != nil {
			return err
		}
		if adopted {
			if err := w.pin.adopt(newPub); err != nil {
				return fmt.Errorf("persist hub pin: %w", err)
			}
		}
		pub = newPub
	}
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil || !ed25519.Verify(pub, []byte(w.cfg.Token), sig) {
		return errBadHubSig
	}
	return nil
}

// tryRotation fetches the advertised hub key after a signature
// failure. A valid proof made by the pinned (previous) key over the
// new pubkey bytes adopts it; anything else is a hard failure so a
// forged key can never replace the pin.
func (w *WSClient) tryRotation(ctx context.Context) (bool, error) {
	r, err := fetchPubkey(ctx, w.ep)
	if err != nil {
		return false, fmt.Errorf("hub signature failed and pubkey refresh failed: %w", err)
	}
	newPub, adopted, err := decideAdopt(w.pin.Current(), r)
	if err != nil {
		return false, fmt.Errorf(
			"hub signature failed and %s; refusing to re-pin (possible MITM; check KEY or hub.key)",
			err)
	}
	if !adopted {
		return false, nil
	}
	if err := w.pin.adopt(newPub); err != nil {
		return false, fmt.Errorf("persist rotated hub pin: %w", err)
	}
	return true, nil
}

func (w *WSClient) readLoop(c *websocket.Conn) {
	c.SetReadLimit(1 << 20)
	_ = c.SetReadDeadline(time.Now().Add(2 * PingInterval))
	c.SetPongHandler(func(string) error {
		return c.SetReadDeadline(time.Now().Add(2 * PingInterval))
	})
	for {
		if _, _, err := c.ReadMessage(); err != nil {
			break
		}
		// Any inbound frame proves the peer alive, so a hub that
		// never pongs but still sends data keeps the link up; only
		// two full intervals of silence kill it.
		_ = c.SetReadDeadline(time.Now().Add(2 * PingInterval))
	}
	w.mu.Lock()
	if w.c == c {
		w.c = nil
	}
	w.mu.Unlock()
	c.Close()
}

// Send writes one metrics frame. Each frame is signed with the agent
// identity key so the hub can verify it end to end, including when the
// bridge reposts it to the REST ingress. A write error drops the
// connection; the next tick reconnects.
func (w *WSClient) Send(p *collect.Payload) error {
	w.mu.Lock()
	c := w.c
	legacy := w.legacyHub
	w.mu.Unlock()
	if c == nil {
		return fmt.Errorf("ws not connected")
	}
	var msg any
	if legacy || w.id == nil {
		msg = wsMetricsLegacy{Type: "metrics", Data: p}
	} else {
		raw, err := json.Marshal(p)
		if err != nil {
			return err
		}
		pub := w.id.Public().(ed25519.PublicKey)
		msg = wsMetrics{
			Type:   "metrics",
			Data:   string(raw),
			Pubkey: base64.StdEncoding.EncodeToString(pub),
			Proof:  base64.StdEncoding.EncodeToString(ed25519.Sign(w.id, raw)),
		}
	}
	// Bound the write: a hub that stops reading must not stall the
	// collection loop on a blocked TCP write. Only this goroutine
	// touches the conn's write deadline; WriteControl (Ping) uses its
	// own deadline and is documented as concurrent-safe.
	_ = c.SetWriteDeadline(time.Now().Add(w.cfg.Timeout))
	if err := c.WriteJSON(msg); err != nil {
		w.mu.Lock()
		if w.c == c {
			w.c = nil
		}
		w.mu.Unlock()
		c.Close()
		return fmt.Errorf("ws send: %w", err)
	}
	return nil
}

// Ping keeps NATs and proxies from idling the link out.
func (w *WSClient) Ping() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.c == nil {
		return fmt.Errorf("ws not connected")
	}
	return w.c.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
}

func (w *WSClient) Close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.c != nil {
		w.c.Close()
		w.c = nil
	}
}
