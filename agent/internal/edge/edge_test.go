package edge

import (
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestLookupExactAndWildcard(t *testing.T) {
	table := &RouteTable{Version: 1, Routes: []Route{
		{Host: "app.example.com", Upstream: "app-rel:8080", TLS: "off"},
		{Host: "*.wild.example.com", Upstream: "wild-rel:8080", TLS: "off"},
		{Host: "*.example.com", Upstream: "base-rel:8080", TLS: "off"},
	}}
	if r := table.lookup("app.example.com"); r == nil || r.Upstream != "app-rel:8080" {
		t.Fatalf("exact match failed: %+v", r)
	}
	if r := table.lookup("sub.wild.example.com"); r == nil || r.Upstream != "wild-rel:8080" {
		t.Fatalf("wildcard match failed: %+v", r)
	}
	// Longest wildcard suffix wins over the shorter one.
	if r := table.lookup("a.b.wild.example.com"); r == nil || r.Upstream != "wild-rel:8080" {
		t.Fatalf("longest wildcard failed: %+v", r)
	}
	if r := table.lookup("other.example.com"); r == nil || r.Upstream != "base-rel:8080" {
		t.Fatalf("base wildcard failed: %+v", r)
	}
	if r := table.lookup("wild.example.com"); r == nil || r.Upstream != "base-rel:8080" {
		// *.wild.example.com must not match its own apex.
		t.Fatalf("apex handling failed: %+v", r)
	}
	if r := table.lookup("example.com"); r != nil {
		t.Fatalf("bare domain must not match *.example.com: %+v", r)
	}
	if r := table.lookup("unrelated.org"); r != nil {
		t.Fatalf("unexpected match: %+v", r)
	}
	var nilTable *RouteTable
	if r := nilTable.lookup("app.example.com"); r != nil {
		t.Fatalf("nil table must not match")
	}
}

func TestHostOnly(t *testing.T) {
	for in, want := range map[string]string{
		"Example.COM":      "example.com",
		"example.com:8080": "example.com",
		"EXAMPLE.com:443":  "example.com",
		"127.0.0.1:9000":   "127.0.0.1",
		"[::1]:8080":       "::1",
		"app-rel_1:8080":   "app-rel_1",
	} {
		if got := hostOnly(in); got != want {
			t.Fatalf("hostOnly(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSecureJoin(t *testing.T) {
	root := t.TempDir()
	good := map[string]string{
		"index.html":      "index.html",
		"assets/a.js":     "assets/a.js",
		"a/./b.txt":       "a/b.txt",
		"assets/../x.txt": "x.txt",
	}
	for in, want := range good {
		got, err := secureJoin(root, in)
		if err != nil {
			t.Fatalf("secureJoin(%q) err: %v", in, err)
		}
		rel, rerr := filepath.Rel(root, got)
		if rerr != nil || rel != filepath.FromSlash(want) {
			t.Fatalf("secureJoin(%q) = %q, want under root as %q", in, got, want)
		}
	}
	for _, bad := range []string{
		"../escape", "..", "/abs/path", "/assets/a.js", "a/../../escape", "~/home",
		"a/b/../../..", "..\\winescape",
	} {
		got, err := secureJoin(root, bad)
		if err == nil {
			// Cleaning can collapse some inputs inside root; only
			// flag when the result actually escapes.
			rel, rerr := filepath.Rel(root, got)
			if rerr != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				t.Fatalf("secureJoin(%q) escaped to %q", bad, got)
			}
		}
	}
}

func TestSafeRelPath(t *testing.T) {
	for _, ok := range []string{"src/app_x/dist", "a", "a/b/c"} {
		if !safeRelPath(ok) {
			t.Fatalf("safeRelPath(%q) = false", ok)
		}
	}
	for _, bad := range []string{"", "..", "../x", "a/../b", "/x", "~x", "a/\x00b"} {
		if safeRelPath(bad) {
			t.Fatalf("safeRelPath(%q) = true", bad)
		}
	}
}

func TestTableValidate(t *testing.T) {
	valid := &RouteTable{Routes: []Route{
		{Host: "a.example.com", Upstream: "app-rel:8080", TLS: "acme"},
		{Host: "*.w.example.com", Upstream: "w-rel:80", TLS: "manual"},
		{Host: "s.example.com", StaticRoot: "src/app_x", TLS: "off"},
	}}
	if err := valid.validate(); err != nil {
		t.Fatalf("valid table rejected: %v", err)
	}
	bad := []Route{
		{Host: "bad host!", Upstream: "x:80", TLS: "acme"},
		{Host: "ok.example.com", Upstream: "x:99999", TLS: "acme"},
		{Host: "ok.example.com", Upstream: "no-port", TLS: "acme"},
		{Host: "ok.example.com", Upstream: "x:80", TLS: "bogus"},
		{Host: "ok.example.com", StaticRoot: "../escape", TLS: "off"},
		{Host: "ok.example.com", TLS: "acme"}, // neither upstream nor staticRoot
	}
	for i, r := range bad {
		tab := &RouteTable{Routes: []Route{r}}
		if err := tab.validate(); err == nil {
			t.Fatalf("bad route %d accepted: %+v", i, r)
		}
	}
	over := &RouteTable{}
	for i := 0; i < maxRoutes+1; i++ {
		over.Routes = append(over.Routes, Route{Host: "a.example.com", Upstream: "x:80", TLS: "off"})
	}
	if err := over.validate(); err == nil {
		t.Fatalf("over-cap table accepted")
	}
}

func TestIsLoopbackAddr(t *testing.T) {
	for _, ok := range []string{"127.0.0.1:8765", "localhost:1", "[::1]:9999"} {
		if !isLoopbackAddr(ok) {
			t.Fatalf("isLoopbackAddr(%q) = false", ok)
		}
	}
	for _, bad := range []string{"0.0.0.0:1", "192.168.1.1:1", "example.com:1", "no-port"} {
		if isLoopbackAddr(bad) {
			t.Fatalf("isLoopbackAddr(%q) = true", bad)
		}
	}
}

// TestTableSwapAtomicity hammers the lookup path while the table is
// swapped; run under -race it proves the atomic handoff.
func TestTableSwapAtomicity(t *testing.T) {
	s := &Server{}
	var wg sync.WaitGroup
	stop := make(chan struct{})
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
					_ = s.routes()
					_ = s.routeForHost("a.example.com")
				}
			}
		}()
	}
	for v := int64(0); v < 1000; v++ {
		s.table.Store(&RouteTable{Version: v, Routes: []Route{
			{Host: "a.example.com", Upstream: "x:80", TLS: "off"},
		}})
	}
	close(stop)
	wg.Wait()
}
