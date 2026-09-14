package send

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/Quad4-Software/Wharfinger/agent/internal/collect"
	"github.com/Quad4-Software/Wharfinger/agent/internal/config"
	"github.com/Quad4-Software/Wharfinger/agent/internal/state"
)

// testHub fakes the hub side of the ws protocol: it signs the bearer
// token with a controllable ed25519 key, issues a nonce, checks the
// hello proof, and captures metrics frames. pubkeyResp drives
// GET /ingress/pubkey for the rotation tests.
type testHub struct {
	mu      sync.Mutex
	priv    ed25519.PrivateKey
	pub     ed25519.PublicKey
	pubJSON string // raw body for GET /ingress/pubkey
	hello   map[string]any
	metrics chan map[string]any
}

func newTestHub(t *testing.T) *testHub {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	h := &testHub{priv: priv, pub: pub, metrics: make(chan map[string]any, 4)}
	h.setPubJSON(map[string]any{"pub": base64.StdEncoding.EncodeToString(pub)})
	return h
}

func (h *testHub) setPubJSON(v map[string]any) {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	h.mu.Lock()
	h.pubJSON = string(b)
	h.mu.Unlock()
}

// rotateTo switches the signing key and advertises it with a proof
// made by the previous key over the new raw pubkey bytes.
func (h *testHub) rotateTo(t *testing.T) (oldPub, newPub ed25519.PublicKey) {
	t.Helper()
	oldPub = h.pub
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	proof := ed25519.Sign(h.priv, pub)
	h.mu.Lock()
	h.priv, h.pub = priv, pub
	h.mu.Unlock()
	h.setPubJSON(map[string]any{
		"pub":        base64.StdEncoding.EncodeToString(pub),
		"prev_pub":   base64.StdEncoding.EncodeToString(oldPub),
		"rotated_at": time.Now().UnixMilli(),
		"proof":      base64.StdEncoding.EncodeToString(proof),
	})
	return oldPub, pub
}

func (h *testHub) handler(token string) http.Handler {
	up := websocket.Upgrader{}
	mux := http.NewServeMux()
	mux.HandleFunc("/ingress/pubkey", func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		body := h.pubJSON
		h.mu.Unlock()
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(body))
	})
	mux.HandleFunc("/ingress/ws", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "Bearer "+token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		h.mu.Lock()
		priv := h.priv
		h.mu.Unlock()
		nonce := make([]byte, 32)
		if _, err := rand.Read(nonce); err != nil {
			return
		}
		_ = c.WriteJSON(map[string]any{
			"type":      "challenge",
			"signature": base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte(token))),
			"nonce":     base64.StdEncoding.EncodeToString(nonce),
		})
		var hello map[string]any
		if err := c.ReadJSON(&hello); err != nil {
			return
		}
		h.mu.Lock()
		h.hello = hello
		h.mu.Unlock()
		// Verify the proof the way /ingress/hello does.
		pubB64, _ := hello["pubkey"].(string)
		proofB64, _ := hello["proof"].(string)
		pub, err1 := base64.StdEncoding.DecodeString(pubB64)
		proof, err2 := base64.StdEncoding.DecodeString(proofB64)
		if err1 != nil || err2 != nil || !ed25519.Verify(ed25519.PublicKey(pub), nonce, proof) {
			_ = c.WriteJSON(map[string]any{"type": "error", "error": "invalid key proof"})
			return
		}
		_ = c.WriteJSON(map[string]any{"type": "ready"})
		for {
			var msg map[string]any
			if err := c.ReadJSON(&msg); err != nil {
				return
			}
			select {
			case h.metrics <- msg:
			default:
			}
		}
	})
	return mux
}

func testConfig(hub *httptest.Server, token string) config.Config {
	return config.Config{
		HubURL:   hub.URL,
		Token:    token,
		Interval: time.Second,
		Timeout:  5 * time.Second,
		Insecure: true,
	}
}

func testClient(t *testing.T, cfg config.Config, st *state.Store) (*WSClient, *HubPin, ed25519.PrivateKey) {
	t.Helper()
	id, err := st.Identity()
	if err != nil {
		t.Fatal(err)
	}
	pin, err := NewHubPin(cfg, st)
	if err != nil {
		t.Fatal(err)
	}
	return NewWSClient(cfg, NewEndpoint(cfg.HubURL), id, pin), pin, id
}

func TestWSHandshakeProofAndSignedFrames(t *testing.T) {
	token := "st_testtoken"
	hub := newTestHub(t)
	srv := httptest.NewServer(hub.handler(token))
	defer srv.Close()

	st, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cfg := testConfig(srv, token)
	cfg.HubKey = base64.StdEncoding.EncodeToString(hub.pub)
	ws, _, id := testClient(t, cfg, st)
	defer ws.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := ws.Connect(ctx, "fp_abc"); err != nil {
		t.Fatalf("connect: %v", err)
	}
	if !ws.Connected() {
		t.Fatal("not connected")
	}

	hub.mu.Lock()
	hello := hub.hello
	hub.mu.Unlock()
	pub := id.Public().(ed25519.PublicKey)
	if hello["pubkey"] != base64.StdEncoding.EncodeToString(pub) {
		t.Fatalf("hello pubkey: %v", hello["pubkey"])
	}
	if hello["proof"] == nil || hello["proof"] == "" {
		t.Fatal("hello missing proof")
	}

	// Metrics frames are signed over the exact JSON bytes.
	p := &collect.Payload{V: 1, Fingerprint: "fp_abc", Ts: time.Now().UnixMilli()}
	if err := ws.Send(p); err != nil {
		t.Fatal(err)
	}
	select {
	case msg := <-hub.metrics:
		data, _ := msg["data"].(string)
		if data == "" {
			t.Fatalf("metrics data not a string: %v", msg["data"])
		}
		proof, _ := base64.StdEncoding.DecodeString(msg["proof"].(string))
		if !ed25519.Verify(pub, []byte(data), proof) {
			t.Fatal("metrics proof does not verify")
		}
		if !json.Valid([]byte(data)) {
			t.Fatal("metrics data is not valid JSON")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no metrics frame received")
	}
}

func TestWSRotationAdoptsWithProof(t *testing.T) {
	token := "st_testtoken"
	hub := newTestHub(t)
	srv := httptest.NewServer(hub.handler(token))
	defer srv.Close()

	st, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cfg := testConfig(srv, token)
	cfg.HubKey = base64.StdEncoding.EncodeToString(hub.pub)
	ws, pin, _ := testClient(t, cfg, st)

	// Rotate the hub key after the agent pinned the old one.
	_, newPub := hub.rotateTo(t)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := ws.Connect(ctx, "fp_abc"); err != nil {
		t.Fatalf("connect after rotation: %v", err)
	}
	defer ws.Close()
	if !bytes.Equal(pin.Current(), newPub) {
		t.Fatal("pin was not updated to the rotated key")
	}
	// The persisted pin moved too.
	stored, err := st.HubPin()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, newPub) {
		t.Fatal("hub.key was not rewritten with the rotated key")
	}
}

func TestWSRotationRefusesWithoutProof(t *testing.T) {
	token := "st_testtoken"
	hub := newTestHub(t)
	srv := httptest.NewServer(hub.handler(token))
	defer srv.Close()

	st, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cfg := testConfig(srv, token)
	oldPub := append(ed25519.PublicKey(nil), hub.pub...)
	cfg.HubKey = base64.StdEncoding.EncodeToString(oldPub)
	ws, pin, _ := testClient(t, cfg, st)
	defer ws.Close()

	// Rotate but advertise no proof: indistinguishable from a MITM.
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	hub.mu.Lock()
	hub.priv, hub.pub = priv, pub
	hub.mu.Unlock()
	hub.setPubJSON(map[string]any{"pub": base64.StdEncoding.EncodeToString(pub)})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err = ws.Connect(ctx, "fp_abc")
	if err == nil {
		t.Fatal("connect must fail when the rotation proof is missing")
	}
	if !strings.Contains(err.Error(), "refusing to re-pin") {
		t.Fatalf("expected MITM refusal, got: %v", err)
	}
	if !bytes.Equal(pin.Current(), oldPub) {
		t.Fatal("pin must not move without a valid proof")
	}
}

func TestWSRotationRefusesWrongProof(t *testing.T) {
	token := "st_testtoken"
	hub := newTestHub(t)
	srv := httptest.NewServer(hub.handler(token))
	defer srv.Close()

	st, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cfg := testConfig(srv, token)
	oldPub := append(ed25519.PublicKey(nil), hub.pub...)
	cfg.HubKey = base64.StdEncoding.EncodeToString(oldPub)
	ws, pin, _ := testClient(t, cfg, st)
	defer ws.Close()

	// Proof signed by an unrelated key, not the pinned one.
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	_, evil, _ := ed25519.GenerateKey(rand.Reader)
	hub.mu.Lock()
	hub.priv, hub.pub = priv, pub
	hub.mu.Unlock()
	hub.setPubJSON(map[string]any{
		"pub":   base64.StdEncoding.EncodeToString(pub),
		"proof": base64.StdEncoding.EncodeToString(ed25519.Sign(evil, pub)),
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := ws.Connect(ctx, "fp_abc"); err == nil {
		t.Fatal("connect must fail on a bad rotation proof")
	}
	if !bytes.Equal(pin.Current(), oldPub) {
		t.Fatal("pin must not move on a bad proof")
	}
}

func TestWSTOFUAdoptsFirstSeenKey(t *testing.T) {
	token := "st_testtoken"
	hub := newTestHub(t)
	srv := httptest.NewServer(hub.handler(token))
	defer srv.Close()

	st, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// No HubKey configured and no hub.key file: first contact pins
	// whatever the hub advertises.
	cfg := testConfig(srv, token)
	ws, pin, _ := testClient(t, cfg, st)
	defer ws.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := ws.Connect(ctx, "fp_abc"); err != nil {
		t.Fatalf("connect: %v", err)
	}
	if !bytes.Equal(pin.Current(), hub.pub) {
		t.Fatal("TOFU did not adopt the advertised key")
	}
	stored, err := st.HubPin()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, hub.pub) {
		t.Fatal("TOFU pin was not persisted")
	}
}

func TestDecideAdopt(t *testing.T) {
	pubA, privA, _ := ed25519.GenerateKey(rand.Reader)
	pubB, _, _ := ed25519.GenerateKey(rand.Reader)
	b64 := func(k ed25519.PublicKey) string { return base64.StdEncoding.EncodeToString(k) }

	// TOFU: no pin adopts unconditionally.
	got, adopted, err := decideAdopt(nil, pubkeyResponse{Pub: b64(pubA)})
	if err != nil || !adopted || !bytes.Equal(got, pubA) {
		t.Fatalf("tofu: %v %v %v", got, adopted, err)
	}
	// Same key: no adoption, no error.
	got, adopted, err = decideAdopt(pubA, pubkeyResponse{Pub: b64(pubA)})
	if err != nil || adopted {
		t.Fatalf("same key: %v %v", adopted, err)
	}
	// Rotation with valid proof adopts.
	proof := ed25519.Sign(privA, pubB)
	got, adopted, err = decideAdopt(pubA, pubkeyResponse{Pub: b64(pubB), Proof: base64.StdEncoding.EncodeToString(proof)})
	if err != nil || !adopted || !bytes.Equal(got, pubB) {
		t.Fatalf("valid proof: %v %v %v", got, adopted, err)
	}
	// Rotation without proof refuses.
	if _, _, err = decideAdopt(pubA, pubkeyResponse{Pub: b64(pubB)}); err == nil {
		t.Fatal("missing proof must fail")
	}
	// Proof over the wrong message refuses.
	badProof := ed25519.Sign(privA, pubA)
	if _, _, err = decideAdopt(pubA, pubkeyResponse{Pub: b64(pubB), Proof: base64.StdEncoding.EncodeToString(badProof)}); err == nil {
		t.Fatal("proof over wrong bytes must fail")
	}
	// Invalid pub encoding refuses.
	if _, _, err = decideAdopt(nil, pubkeyResponse{Pub: "!!!"}); err == nil {
		t.Fatal("invalid pub must fail")
	}
}

func TestHubPinConfiguredKeySeedsFile(t *testing.T) {
	st, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	cfg := config.Config{HubKey: base64.StdEncoding.EncodeToString(pub)}
	pin, err := NewHubPin(cfg, st)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := st.HubPin()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, pub) || !bytes.Equal(pin.Current(), pub) {
		t.Fatal("configured KEY was not seeded to hub.key")
	}
	// A changed configured KEY wins over the stored pin.
	pub2, _, _ := ed25519.GenerateKey(rand.Reader)
	cfg.HubKey = base64.StdEncoding.EncodeToString(pub2)
	pin, err = NewHubPin(cfg, st)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(pin.Current(), pub2) {
		t.Fatal("changed KEY must override the stored pin")
	}
}
