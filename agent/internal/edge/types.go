// Package edge serves the domains declared by deployed apps: it
// polls the hub route table, reverse-proxies each host to the app's
// live container (or serves static files), and manages TLS via ACME.
// The wire types mirror src/lib/shared/edge.ts.
package edge

import (
	"regexp"
	"strings"
)

// hostRe accepts a hostname or a single leading-label wildcard
// (*.example.com); upstreamRe accepts host:port where host is a
// hostname, ipv4, or container name. Both mirror the hub-side
// validators in src/lib/shared/edge.ts.
var (
	hostRe     = regexp.MustCompile(`(?i)^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$`)
	upstreamRe = regexp.MustCompile(`(?i)^[a-z0-9][a-z0-9._-]*:[0-9]{1,5}$`)
)

// Route is one domain served by this agent. Exactly one of
// Upstream/StaticRoot is set: Upstream is the host:port of the live
// container on the runtime network, StaticRoot is a path relative to
// the agent state dir for statically served apps.
type Route struct {
	Host       string `json:"host"`
	Upstream   string `json:"upstream,omitempty"`
	AppID      string `json:"appId"`
	TLS        string `json:"tls"` // acme | manual | off
	StaticRoot string `json:"staticRoot,omitempty"`
}

// RouteTable is the versioned payload from GET /ingress/routes.
// Version is an opaque stamp: it only ever needs equality checks.
type RouteTable struct {
	Version int64   `json:"version"`
	Routes  []Route `json:"routes"`
}

// CertInfo is one certificate inventory entry. The integrator
// attaches the slice to the metrics payload so the hub can show
// expiry per host.
type CertInfo struct {
	Host      string `json:"host"`
	ExpiresAt int64  `json:"expiresAt"` // unix milliseconds
	Issuer    string `json:"issuer"`
	Status    string `json:"status"` // valid | expiring | expired | pending
}

// lookup finds the route for a request host: exact match first,
// then the longest wildcard suffix match (*.example.com covers
// a.example.com and a.b.example.com).
func (t *RouteTable) lookup(host string) *Route {
	if t == nil {
		return nil
	}
	var wild *Route
	wildLen := -1
	for i := range t.Routes {
		r := &t.Routes[i]
		if r.Host == host {
			return r
		}
		if len(r.Host) > 2 && r.Host[0] == '*' && r.Host[1] == '.' {
			suffix := r.Host[1:] // ".example.com"
			if len(host) > len(suffix) && hasSuffixFold(host, suffix) && len(suffix) > wildLen {
				wild = r
				wildLen = len(suffix)
			}
		}
	}
	return wild
}

func hasSuffixFold(s, suffix string) bool {
	if len(s) < len(suffix) {
		return false
	}
	return strings.EqualFold(s[len(s)-len(suffix):], suffix)
}
