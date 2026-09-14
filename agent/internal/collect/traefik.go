package collect

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// Traefik exposes its inventory through the API handler, enabled by
// --api / --api.insecure or a secured dashboard router. The agent
// probes the node-local default and honors WHARFINGER_TRAEFIK_API for
// custom ports, auth-proxied URLs, or remote instances.
func traefikBase() string {
	if v := os.Getenv("WHARFINGER_TRAEFIK_API"); v != "" {
		return strings.TrimRight(v, "/")
	}
	return "http://127.0.0.1:8080"
}

type traefikSection struct {
	Total    int `json:"total"`
	Warnings int `json:"warnings"`
	Errors   int `json:"errors"`
}

type traefikOverview struct {
	HTTP struct {
		Routers     traefikSection `json:"routers"`
		Services    traefikSection `json:"services"`
		Middlewares traefikSection `json:"middlewares"`
	} `json:"http"`
	TCP struct {
		Routers  traefikSection `json:"routers"`
		Services traefikSection `json:"services"`
	} `json:"tcp"`
	UDP struct {
		Routers traefikSection `json:"routers"`
	} `json:"udp"`
}

func traefikMetrics() *Traefik {
	c := &http.Client{Timeout: 3 * time.Second}
	res, err := c.Get(traefikBase() + "/api/overview")
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil
	}
	var ov traefikOverview
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&ov); err != nil {
		return nil
	}
	t := &Traefik{
		HTTPRouters:    ov.HTTP.Routers.Total,
		HTTPServices:   ov.HTTP.Services.Total,
		Middlewares:    ov.HTTP.Middlewares.Total,
		TCPRouters:     ov.TCP.Routers.Total,
		TCPServices:    ov.TCP.Services.Total,
		UDPRouters:     ov.UDP.Routers.Total,
		RouterErrors:   ov.HTTP.Routers.Errors + ov.TCP.Routers.Errors + ov.UDP.Routers.Errors,
		RouterWarnings: ov.HTTP.Routers.Warnings + ov.TCP.Routers.Warnings + ov.UDP.Routers.Warnings,
	}
	if t.HTTPRouters == 0 && t.HTTPServices == 0 && t.TCPRouters == 0 {
		return nil // reachable endpoint but not traefik's shape
	}
	return t
}
