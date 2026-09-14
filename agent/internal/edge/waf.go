package edge

import (
	"bufio"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// WAF posture ported from the RavenGuard policy blocks that make
// sense on a single-host proxy: IP block/allow lists, UA blocklists,
// and a per-IP rate limit. The detect/challenge layers and the
// process sandbox (seccomp/landlock) are deliberately absent: the
// first needs telemetry we do not collect, and a process-wide syscall
// filter would break the agent's docker and kubectl control paths.

// Policy is the hot-swappable WAF state: parsed block/allow lists
// plus the rate limit knobs. A nil *Policy means no WAF at all.
type Policy struct {
	blockIPs []*net.IPNet
	allowIPs []*net.IPNet
	blockUA  []string // case-insensitive substrings
	rate     float64  // tokens per second; <= 0 disables limiting
	burst    float64
}

// PolicyConfig names the operator-managed list files and the rate
// limit. All fields are optional; an all-empty config produces a nil
// policy. List files hold one entry per line: IPs or CIDRs for the
// ip lists, case-insensitive substrings for the UA list. Lines
// starting with # and blank lines are ignored.
type PolicyConfig struct {
	BlockIPs  string
	AllowIPs  string
	BlockUA   string
	Rate      float64 // sustained requests per second per client IP
	RateBurst int     // bucket capacity; defaults to Rate when <= 0
}

// LoadPolicy reads the configured list files. Unreadable files are
// skipped so a missing list never takes the proxy down; malformed
// lines are ignored individually.
func LoadPolicy(cfg PolicyConfig) *Policy {
	p := &Policy{rate: cfg.Rate, burst: float64(cfg.RateBurst)}
	if p.burst <= 0 {
		p.burst = p.rate
	}
	p.blockIPs = parseNetList(cfg.BlockIPs)
	p.allowIPs = parseNetList(cfg.AllowIPs)
	p.blockUA = parseUAList(cfg.BlockUA)
	if len(p.blockIPs) == 0 && len(p.allowIPs) == 0 && len(p.blockUA) == 0 && p.rate <= 0 {
		return nil
	}
	return p
}

func parseNetList(path string) []*net.IPNet {
	var out []*net.IPNet
	for _, line := range readLines(path) {
		if _, n, err := net.ParseCIDR(line); err == nil {
			out = append(out, n)
			continue
		}
		if ip := net.ParseIP(line); ip != nil {
			bits := 128
			if ip.To4() != nil {
				bits = 32
			}
			out = append(out, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
		}
	}
	return out
}

func parseUAList(path string) []string {
	var out []string
	for _, line := range readLines(path) {
		out = append(out, strings.ToLower(line))
	}
	return out
}

func readLines(path string) []string {
	if path == "" {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		out = append(out, line)
	}
	return out
}

func netsContain(nets []*net.IPNet, ip net.IP) bool {
	for _, n := range nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// limiter is a per-IP token bucket map with a hard entry cap; stale
// buckets are swept when the cap is hit so a rotating-flood cannot
// grow memory without bound.
type limiter struct {
	mu      sync.Mutex
	rate    float64
	burst   float64
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	last   int64 // unix nano
}

const maxBuckets = 1 << 14

func newLimiter(rate, burst float64) *limiter {
	return &limiter{rate: rate, burst: burst, buckets: make(map[string]*bucket)}
}

// allow reports whether one request from key may proceed now.
func (l *limiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.buckets[key]
	if !ok {
		if len(l.buckets) >= maxBuckets {
			l.sweep(now)
		}
		b = &bucket{tokens: l.burst, last: now.UnixNano()}
		l.buckets[key] = b
	}
	refill := float64(now.UnixNano()-b.last) / float64(time.Second) * l.rate
	b.last = now.UnixNano()
	b.tokens += refill
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// sweep drops buckets that have fully refilled; a blocked attacker
// keeps its entry so pressure stays on the offender.
func (l *limiter) sweep(now time.Time) {
	for k, b := range l.buckets {
		idle := now.UnixNano() - b.last
		if float64(idle)/float64(time.Second)*l.rate+b.tokens >= l.burst {
			delete(l.buckets, k)
		}
	}
}

// guard combines the policy with its limiter; rebuilt on every route
// sync so list-file edits land within one poll interval.
type guard struct {
	policy  *Policy
	limiter *limiter
	now     func() time.Time
}

func newGuard(p *Policy) *guard {
	g := &guard{policy: p, now: time.Now}
	if p != nil && p.rate > 0 {
		g.limiter = newLimiter(p.rate, p.burst)
	}
	return g
}

// clientIP trusts the socket peer only: the edge is the outermost
// hop, and honoring X-Forwarded-For here would let any client pick
// its own bucket or dodge a block entry.
func clientIP(r *http.Request) net.IP {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	return net.ParseIP(host)
}

// admit runs the policy chain: IP deny, UA deny, then (unless the
// client is allowlisted) the rate limiter. Returns false when the
// request was answered and must not continue.
func (g *guard) admit(w http.ResponseWriter, r *http.Request) bool {
	p := g.policy
	if p == nil {
		return true
	}
	ip := clientIP(r)
	if ip != nil && netsContain(p.blockIPs, ip) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return false
	}
	ua := strings.ToLower(r.UserAgent())
	for _, pat := range p.blockUA {
		if strings.Contains(ua, pat) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return false
		}
	}
	allowlisted := ip != nil && netsContain(p.allowIPs, ip)
	if g.limiter != nil && !allowlisted {
		key := r.RemoteAddr
		if ip != nil {
			key = ip.String()
		}
		if !g.limiter.allow(key, g.now()) {
			w.Header().Set("Retry-After", "1")
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return false
		}
	}
	return true
}
