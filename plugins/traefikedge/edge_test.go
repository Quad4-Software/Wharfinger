package traefikedge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestNewRequiresConfig(t *testing.T) {
	if _, err := New(context.Background(), nil, &Config{}, "test"); err == nil {
		t.Fatal("expected error for missing hubUrl/token")
	}
}

func TestNewRejectsCleartextRemoteHub(t *testing.T) {
	_, err := New(context.Background(), nil, &Config{
		HubURL: "http://status.example.com",
		Token:  "st_x",
	}, "test")
	if err == nil || !strings.Contains(err.Error(), "https") {
		t.Fatalf("expected https enforcement, got %v", err)
	}
}

func TestNewAllowsLoopbackHTTP(t *testing.T) {
	for _, u := range []string{"http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"} {
		if _, err := New(context.Background(), nil, &Config{HubURL: u, Token: "st_x"}, "test"); err != nil {
			t.Fatalf("loopback %s rejected: %v", u, err)
		}
	}
}

func TestNewClampsBounds(t *testing.T) {
	cfg := &Config{HubURL: "http://localhost:3000", Token: "st_x", MaxClients: 99999}
	h, err := New(context.Background(), nil, cfg, "test")
	if err != nil {
		t.Fatal(err)
	}
	_ = h
	if cfg.MaxClients != schemaMaxClients {
		t.Fatalf("MaxClients = %d, want %d", cfg.MaxClients, schemaMaxClients)
	}
}

func TestServeHTTPCountsAndFlushPosts(t *testing.T) {
	var received atomic.Int32
	var last atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer st_test" {
			t.Error("missing bearer token")
		}
		var rep report
		if err := json.NewDecoder(r.Body).Decode(&rep); err == nil {
			last.Store(&rep)
		}
		received.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	// httptest serves http on a loopback address, allowed by New.
	cfg := &Config{HubURL: srv.URL, Token: "st_test", IntervalSeconds: 1}
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/boom" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	h, err := New(context.Background(), inner, cfg, "test")
	if err != nil {
		t.Fatal(err)
	}
	e := h.(*Edge)
	defer func() {
		// Stop the flush goroutine.
		_ = e
	}()

	req := httptest.NewRequest(http.MethodGet, "/ok", nil)
	req.RemoteAddr = "10.0.0.1:1234"
	h.ServeHTTP(httptest.NewRecorder(), req)

	req2 := httptest.NewRequest(http.MethodGet, "/boom", nil)
	req2.RemoteAddr = "10.0.0.2:1234"
	h.ServeHTTP(httptest.NewRecorder(), req2)

	e.flush()
	if received.Load() != 1 {
		t.Fatalf("expected 1 report, got %d", received.Load())
	}
	rep := last.Load().(*report)
	if rep.Requests != 2 || rep.S2xx != 1 || rep.S5xx != 1 {
		t.Fatalf("bad counters: %+v", rep)
	}
	if len(rep.Errors) != 1 || rep.Errors[0].Status != 500 {
		t.Fatalf("expected one 5xx error sample, got %+v", rep.Errors)
	}
	if len(rep.Clients) != 2 {
		t.Fatalf("expected 2 clients, got %+v", rep.Clients)
	}
}

func TestClientIPTrustForwarded(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "192.0.2.1:9999"
	req.Header.Set("X-Forwarded-For", "203.0.113.7, 198.51.100.2")
	if got := clientIP(req, false); got != "192.0.2.1" {
		t.Fatalf("untrusted xff used: %s", got)
	}
	if got := clientIP(req, true); got != "203.0.113.7" {
		t.Fatalf("trusted xff not used: %s", got)
	}
}

func TestStatusWriterUnwrap(t *testing.T) {
	rec := httptest.NewRecorder()
	w := &statusWriter{ResponseWriter: rec, status: http.StatusOK}
	if w.Unwrap() != rec {
		t.Fatal("Unwrap did not return underlying writer")
	}
	w.WriteHeader(404)
	if w.status != 404 {
		t.Fatalf("status = %d, want 404", w.status)
	}
}

func TestFlushDropsEmptyWindow(t *testing.T) {
	var received atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received.Add(1)
	}))
	defer srv.Close()
	cfg := &Config{HubURL: srv.URL, Token: "st_test"}
	h, _ := New(context.Background(), nil, cfg, "test")
	e := h.(*Edge)
	e.at = time.Now()
	e.flush()
	if received.Load() != 0 {
		t.Fatal("empty window should not post")
	}
}
