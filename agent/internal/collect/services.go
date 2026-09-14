package collect

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

func serviceMetrics() []ServiceState {
	if out := systemdServices(); len(out) > 0 {
		return out
	}
	return openrcServices()
}

// resolveBin prefers absolute paths in root-owned directories so a
// poisoned PATH cannot redirect execution for a root-running agent
// (the class behind CVE-2024-32019 in netdata's ndsudo). Falls back
// to a normal PATH lookup for non-standard installs. Results are
// memoized: binaries do not move during the process lifetime, and
// the stat walk otherwise ran for every exec call on every sample.
var binCache sync.Map

func resolveBin(name string) string {
	if v, ok := binCache.Load(name); ok {
		return v.(string)
	}
	p := name
	for _, dir := range []string{
		"/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin",
	} {
		cand := dir + "/" + name
		if st, err := os.Stat(cand); err == nil && !st.IsDir() {
			p = cand
			break
		}
	}
	binCache.Store(name, p)
	return p
}

func runCmd(timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return exec.CommandContext(ctx, resolveBin(name), args...).Output()
}

// systemdUnit mirrors the rows of systemctl --output=json (v250+).
type systemdUnit struct {
	Unit   string `json:"unit"`
	Load   string `json:"load"`
	Active string `json:"active"`
	Sub    string `json:"sub"`
}

// parseSystemdJSON parses the --output=json unit list. Only service
// units that systemd considers worth showing are kept.
func parseSystemdJSON(data []byte) []ServiceState {
	var units []systemdUnit
	if err := json.Unmarshal(data, &units); err != nil {
		return nil
	}
	var out []ServiceState
	for _, u := range units {
		if !strings.HasSuffix(u.Unit, ".service") || u.Load != "loaded" {
			continue
		}
		state := u.Active
		if u.Sub == "failed" || u.Active == "failed" {
			state = "failed"
		}
		out = append(out, ServiceState{
			Name:    strings.TrimSuffix(u.Unit, ".service"),
			Manager: "systemd",
			State:   state,
			Sub:     u.Sub,
		})
	}
	return out
}

// parseSystemdText handles older systemctl without JSON output:
// "UNIT LOAD ACTIVE SUB DESCRIPTION" rows with --no-legend.
func parseSystemdText(data string) []ServiceState {
	var out []ServiceState
	for _, line := range strings.Split(data, "\n") {
		f := strings.Fields(line)
		if len(f) < 4 || !strings.HasSuffix(f[0], ".service") {
			continue
		}
		state := f[2]
		if f[3] == "failed" || f[2] == "failed" {
			state = "failed"
		}
		out = append(out, ServiceState{
			Name:    strings.TrimSuffix(f[0], ".service"),
			Manager: "systemd",
			State:   state,
			Sub:     f[3],
		})
	}
	return out
}

func systemdServices() []ServiceState {
	b, err := runCmd(5*time.Second, "systemctl", "list-units",
		"--type=service", "--all", "--no-legend", "--no-pager", "--output=json")
	if err == nil {
		if out := parseSystemdJSON(b); len(out) > 0 {
			return out
		}
		// JSON flag unknown on this version: fall back to text parse.
		if out := parseSystemdText(string(b)); len(out) > 0 {
			return out
		}
	}
	b, err = runCmd(5*time.Second, "systemctl", "list-units",
		"--type=service", "--all", "--no-legend", "--no-pager")
	if err != nil {
		return nil
	}
	return parseSystemdText(string(b))
}

// parseRcStatus parses `rc-status --servicelist` rows:
// "servicename [ started ]" or "servicename [ stopped ]".
func parseRcStatus(data string) []ServiceState {
	var out []ServiceState
	for _, line := range strings.Split(data, "\n") {
		line = strings.TrimSpace(line)
		i := strings.Index(line, "[")
		j := strings.LastIndex(line, "]")
		if i < 0 || j < i {
			continue
		}
		name := strings.TrimSpace(line[:i])
		state := strings.TrimSpace(line[i+1 : j])
		if name == "" || state == "" {
			continue
		}
		mapped := state
		switch state {
		case "started":
			mapped = "active"
		case "stopped", "crashed":
			mapped = "inactive"
		}
		out = append(out, ServiceState{Name: name, Manager: "openrc", State: mapped, Sub: state})
	}
	return out
}

func openrcServices() []ServiceState {
	b, err := runCmd(5*time.Second, "rc-status", "--servicelist")
	if err != nil {
		return nil
	}
	return parseRcStatus(string(b))
}
