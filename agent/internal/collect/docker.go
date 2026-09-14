package collect

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Container stats go over the docker-compatible unix API (docker and
// podman both serve it); this avoids pulling the whole SDK tree.
// Podman rootless listens inside the user's runtime dir.
type runtimeSocket struct {
	runtime string
	socket  string
}

func runtimeSockets() []runtimeSocket {
	var out []runtimeSocket
	seen := map[string]bool{}
	add := func(rt, sock string) {
		// XDG_RUNTIME_DIR and the getuid fallback usually resolve to
		// the same rootless socket; list each path once.
		if seen[sock] {
			return
		}
		if st, err := os.Stat(sock); err == nil && !st.IsDir() {
			seen[sock] = true
			out = append(out, runtimeSocket{runtime: rt, socket: sock})
		}
	}
	add("docker", "/var/run/docker.sock")
	add("podman", "/run/podman/podman.sock")
	if dir := os.Getenv("XDG_RUNTIME_DIR"); dir != "" {
		add("podman", dir+"/podman/podman.sock")
	}
	add("podman", "/run/user/"+strconv.Itoa(os.Getuid())+"/podman/podman.sock")
	return out
}

// rtClients caches one client per runtime socket; building a fresh
// transport every sample leaked dialers until GC.
var rtClients sync.Map

func runtimeClient(sock string) *http.Client {
	if v, ok := rtClients.Load(sock); ok {
		return v.(*http.Client)
	}
	c := &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "unix", sock)
			},
		},
	}
	rtClients.Store(sock, c)
	return c
}

type dockerListEntry struct {
	ID     string   `json:"Id"`
	Names  []string `json:"Names"`
	Image  string   `json:"Image"`
	State  string   `json:"State"`
	Status string   `json:"Status"`
	Ports  []struct {
		IP          string `json:"IP"`
		PrivatePort int    `json:"PrivatePort"`
		PublicPort  int    `json:"PublicPort"`
		Type        string `json:"Type"`
	} `json:"Ports"`
}

type dockerStatsResp struct {
	Name     string `json:"name"`
	CPUDelta uint64 `json:"-"`
	CPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs     uint32 `json:"online_cpus"`
	} `json:"cpu_stats"`
	PreCPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
	} `json:"precpu_stats"`
	MemoryStats struct {
		Usage uint64 `json:"usage"`
		Limit uint64 `json:"limit"`
	} `json:"memory_stats"`
	RestartCount int `json:"-"`
}

func dockerGet(c *http.Client, path string, v any) error {
	req, err := http.NewRequest(http.MethodGet, "http://runtime"+path, nil)
	if err != nil {
		return err
	}
	res, err := c.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return errors.New("runtime api status " + res.Status)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(v)
}

// dockerMetrics walks every detected docker-compatible socket
// (docker, podman rootful, podman rootless) and merges the container
// lists. Missing runtimes are skipped silently.
func dockerMetrics() *Docker {
	var d *Docker
	seenIDs := map[string]bool{} // two socket paths can reach one daemon
	for _, rs := range runtimeSockets() {
		c := runtimeClient(rs.socket)
		var list []dockerListEntry
		if err := dockerGet(c, "/containers/json?all=1&limit=100", &list); err != nil {
			continue // dead socket or no permission
		}
		if d == nil {
			d = &Docker{}
		}
		for _, e := range list {
			if seenIDs[e.ID] {
				continue
			}
			seenIDs[e.ID] = true
			d.Total++
			if e.State == "running" {
				d.Running++
			}
			name := ""
			if len(e.Names) > 0 {
				name = strings.TrimPrefix(e.Names[0], "/")
			}
			ct := DockerContainer{
				ID:      e.ID[:min(12, len(e.ID))],
				Name:    name,
				Image:   e.Image,
				State:   e.State,
				Status:  e.Status,
				Runtime: rs.runtime,
			}
			if e.State == "running" {
				fillContainerStats(c, e.ID, &ct)
			}
			d.Containers = append(d.Containers, ct)
		}
	}
	return d
}

// publishedHostPorts lists container ports bound on the host across
// every detected runtime socket (running containers only). docker
// and podman publish these through their own NAT rules, which bypass
// firewalld zone filtering; the firewalld collector compares them
// against the ports the zones actually open.
func publishedHostPorts() []string {
	seen := map[string]bool{}
	var out []string
	for _, rs := range runtimeSockets() {
		var list []dockerListEntry
		if err := dockerGet(runtimeClient(rs.socket), "/containers/json?limit=100", &list); err != nil {
			continue
		}
		for _, e := range list {
			for _, p := range e.Ports {
				if p.PublicPort <= 0 {
					continue
				}
				key := strconv.Itoa(p.PublicPort) + "/" + p.Type
				if !seen[key] {
					seen[key] = true
					out = append(out, key)
				}
			}
		}
	}
	sort.Strings(out)
	return out
}

// fillContainerStats takes a one-shot stats sample plus the inspect
// restart count. Both calls are best-effort.
func fillContainerStats(c *http.Client, id string, ct *DockerContainer) {
	var st dockerStatsResp
	if err := dockerGet(c, "/containers/"+id+"/stats?stream=false&one-shot=true", &st); err == nil {
		cpuDelta := float64(st.CPUStats.CPUUsage.TotalUsage - st.PreCPUStats.CPUUsage.TotalUsage)
		sysDelta := float64(st.CPUStats.SystemCPUUsage - st.PreCPUStats.SystemCPUUsage)
		if cpuDelta > 0 && sysDelta > 0 {
			cpus := float64(st.CPUStats.OnlineCPUs)
			if cpus == 0 {
				cpus = 1
			}
			ct.CPUPct = round1(cpuDelta / sysDelta * cpus * 100)
		}
		ct.MemUsed = st.MemoryStats.Usage
		ct.MemLimit = st.MemoryStats.Limit
	}
	var insp struct {
		RestartCount int `json:"RestartCount"`
	}
	if err := dockerGet(c, "/containers/"+id+"/json", &insp); err == nil {
		ct.Restarts = insp.RestartCount
	}
}
