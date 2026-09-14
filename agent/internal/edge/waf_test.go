package edge

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeList(t *testing.T, lines ...string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "list.txt")
	if err := os.WriteFile(p, []byte(joinLines(lines...)), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func joinLines(lines ...string) string {
	out := ""
	for _, l := range lines {
		out += l + "\n"
	}
	return out
}

func mkReq(ip, ua string) *http.Request {
	r := httptest.NewRequest("GET", "http://app.example.com/", nil)
	r.RemoteAddr = ip + ":12345"
	r.Header.Set("User-Agent", ua)
	return r
}

func TestLoadPolicyEmptyIsNil(t *testing.T) {
	if p := LoadPolicy(PolicyConfig{}); p != nil {
		t.Fatalf("empty config must produce nil policy, got %+v", p)
	}
	// Unreadable files alone still produce nil.
	if p := LoadPolicy(PolicyConfig{BlockIPs: "/nonexistent/x"}); p != nil {
		t.Fatalf("missing file must produce nil policy, got %+v", p)
	}
}

func TestLoadPolicyParses(t *testing.T) {
	p := LoadPolicy(PolicyConfig{
		BlockIPs: writeList(t, "# comment", "203.0.113.0/24", "198.51.100.7", "", "bogus line"),
		AllowIPs: writeList(t, "10.0.0.0/8"),
		BlockUA:  writeList(t, "BadBot", "# skip me"),
	})
	if p == nil || len(p.blockIPs) != 2 || len(p.allowIPs) != 1 || len(p.blockUA) != 1 {
		t.Fatalf("parse failed: %+v", p)
	}
	if p.blockUA[0] != "badbot" {
		t.Fatalf("UA patterns must be lowercased, got %q", p.blockUA[0])
	}
}

func TestAdmitBlockIP(t *testing.T) {
	g := newGuard(LoadPolicy(PolicyConfig{BlockIPs: writeList(t, "203.0.113.0/24")}))
	w := httptest.NewRecorder()
	if g.admit(w, mkReq("203.0.113.9", "Mozilla/5.0")) {
		t.Fatal("blocked CIDR member must be denied")
	}
	if w.Code != 403 {
		t.Fatalf("want 403, got %d", w.Code)
	}
	if !g.admit(httptest.NewRecorder(), mkReq("198.51.100.1", "Mozilla/5.0")) {
		t.Fatal("outside CIDR must be admitted")
	}
}

func TestAdmitBlockUA(t *testing.T) {
	g := newGuard(LoadPolicy(PolicyConfig{BlockUA: writeList(t, "sqlmap")}))
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "198.51.100.1:9"
	r.Header.Set("User-Agent", "sqlmap/1.7")
	w := httptest.NewRecorder()
	if g.admit(w, r) || w.Code != 403 {
		t.Fatalf("blocked UA must be denied, code %d", w.Code)
	}
}

func TestRateLimit(t *testing.T) {
	now := time.Unix(1_000, 0)
	p := LoadPolicy(PolicyConfig{Rate: 2, RateBurst: 2})
	g := newGuard(p)
	g.now = func() time.Time { return now }

	mk := func() (*httptest.ResponseRecorder, bool) {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = "198.51.100.1:9"
		w := httptest.NewRecorder()
		return w, g.admit(w, r)
	}
	if _, ok := mk(); !ok {
		t.Fatal("first request must pass")
	}
	if _, ok := mk(); !ok {
		t.Fatal("burst request must pass")
	}
	w, ok := mk()
	if ok || w.Code != 429 {
		t.Fatalf("third request must 429, got %d", w.Code)
	}
	if w.Header().Get("Retry-After") == "" {
		t.Fatal("429 must carry Retry-After")
	}
	// Half a second later one token has refilled.
	now = now.Add(500 * time.Millisecond)
	if _, ok := mk(); !ok {
		t.Fatal("request after refill must pass")
	}
}

func TestAllowlistSkipsRateLimit(t *testing.T) {
	g := newGuard(LoadPolicy(PolicyConfig{
		Rate:      1,
		RateBurst: 1,
		AllowIPs:  writeList(t, "10.9.9.0/24"),
	}))
	mk := func() bool {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = "10.9.9.5:9"
		return g.admit(httptest.NewRecorder(), r)
	}
	for i := 0; i < 5; i++ {
		if !mk() {
			t.Fatalf("allowlisted client hit the limiter on request %d", i)
		}
	}
}

func TestLimiterSweepCapsMemory(t *testing.T) {
	l := newLimiter(1, 1)
	now := time.Unix(1_000, 0)
	for i := 0; i < maxBuckets+64; i++ {
		l.buckets[string(rune(i))] = &bucket{tokens: 1, last: now.Add(-time.Hour).UnixNano()}
	}
	l.sweep(time.Unix(2_000, 0))
	if len(l.buckets) != 0 {
		t.Fatalf("sweep must drop fully refilled buckets, %d left", len(l.buckets))
	}
}

func TestNilPolicyAdmits(t *testing.T) {
	g := newGuard(nil)
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "198.51.100.1:9"
	if !g.admit(httptest.NewRecorder(), r) {
		t.Fatal("nil policy must admit everything")
	}
}
