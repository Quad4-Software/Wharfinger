package edge

import (
	"context"
	"net"
	"net/http"
	"net/http/httputil"
	"strings"
	"time"
)

const (
	dialTimeout  = 10 * time.Second
	proxyTimeout = 60 * time.Second
)

// transport is shared by all upstream hops: container-name upstreams
// must never go through an HTTP_PROXY from the environment.
var transport = &http.Transport{
	DialContext:           (&net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}).DialContext,
	MaxIdleConns:          128,
	MaxIdleConnsPerHost:   16,
	IdleConnTimeout:       90 * time.Second,
	ResponseHeaderTimeout: proxyTimeout,
	ExpectContinueTimeout: time.Second,
}

// serveProxy forwards the request to the route's upstream over plain
// HTTP (container network). The upstream hop gets its own 60s budget
// through the request context; dial is capped at 10s by the
// transport. X-Forwarded-For is appended by ReverseProxy; proto and
// the upstream Host are rewritten in the director.
func (s *Server) serveProxy(w http.ResponseWriter, r *http.Request, rt *Route) {
	upHost := rt.Upstream
	ctx, cancel := context.WithTimeout(r.Context(), proxyTimeout)
	defer cancel()

	proto := "http"
	if r.TLS != nil {
		proto = "https"
	}
	proxy := &httputil.ReverseProxy{
		Director: func(rq *http.Request) {
			rq.URL.Scheme = "http"
			rq.URL.Host = upHost
			// Host header rewritten to the upstream name so
			// name-based vhosts in containers see the container
			// identity, not the public domain.
			rq.Host = hostOnly(upHost)
			rq.Header.Set("X-Forwarded-Proto", proto)
		},
		Transport: transport,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			http.Error(w, "upstream unavailable", http.StatusBadGateway)
		},
	}
	proxy.ServeHTTP(w, r.WithContext(ctx))
}

// safeRelPath reports whether rel is a clean relative path: no
// traversal, absolute anchor, or tilde. staticRoot arrives
// slash-separated from the hub.
func safeRelPath(rel string) bool {
	return rel != "" &&
		rel != ".." && !strings.HasPrefix(rel, "../") && !strings.Contains(rel, "/../") &&
		!strings.HasPrefix(rel, "/") && !strings.HasPrefix(rel, "~") &&
		!strings.ContainsAny(rel, "\x00\n\r")
}
