package collect

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Reticulum node state: a reticulum-go daemon (Quad4) or a Python rnsd.
// Introspection prefers the localhost Control API when the config
// enables it and rpc_key is readable, then falls back to parsing the
// status CLI text (reticulum-go status / rgostatus / rnstatus).
type Reticulum struct {
	Running    bool           `json:"running"`
	Flavor     string         `json:"flavor,omitempty"` // go | python
	Version    string         `json:"version,omitempty"`
	Identity   string         `json:"identity,omitempty"`
	UptimeS    int64          `json:"uptimeSec,omitempty"`
	Interfaces []RnsInterface `json:"interfaces,omitempty"`
	Paths      int            `json:"paths,omitempty"`
	Findings   []string       `json:"findings,omitempty"`
}

type RnsInterface struct {
	Name    string `json:"name"`
	Type    string `json:"type,omitempty"`
	Status  string `json:"status"` // up | down
	Mode    string `json:"mode,omitempty"`
	Clients int    `json:"clients,omitempty"`
	RxBytes uint64 `json:"rxBytes,omitempty"`
	TxBytes uint64 `json:"txBytes,omitempty"`
}

// reticulumConfig holds the bits of ~/.reticulum-go/config the
// collector needs. The INI dialect is Python-compatible; parsing is
// deliberately loose so unknown keys never break the read.
type reticulumConfig struct {
	controlAPI bool
	apiHost    string
	apiPort    int
	rpcKey     string
	ifaceCount int
}

// rnsBin probes cache binary existence so the sampler never re-execs
// missing tools on every tick.
var rnsBin sync.Map

func rnsBinWorks(name string, args ...string) bool {
	if v, ok := rnsBin.Load(name); ok {
		return v.(bool)
	}
	_, err := runCmd(3*time.Second, name, args...)
	ok := err == nil
	rnsBin.Store(name, ok)
	return ok
}

func reticulumMetrics() *Reticulum {
	r := &Reticulum{}
	cfg := readReticulumConfig()

	goRunning := procCommRunning("reticulum-go")
	pyRunning := procCommRunning("rnsd")

	// A running daemon picks the flavor; otherwise probe the binaries
	// with --help (exec resolves PATH; a bare reticulum-go would start
	// a daemon, so never invoke it without a subcommand).
	if goRunning || (!pyRunning && rnsBinWorks("reticulum-go", "--help")) {
		r.Flavor = "go"
		if v, err := runCmd(3*time.Second, "reticulum-go", "version"); err == nil {
			r.Version = firstLine(string(v))
		}
	} else if pyRunning || rnsBinWorks("rnstatus", "--help") {
		r.Flavor = "python"
	}
	r.Running = goRunning || pyRunning

	if r.Flavor == "" && cfg.ifaceCount == 0 {
		return nil
	}

	// Control API gives the richest data when enabled and the key is
	// readable; the CLI text output is the portable fallback.
	if cfg.controlAPI && cfg.rpcKey != "" {
		if err := reticulumControlAPI(r, cfg); err == nil {
			r.Running = true
		}
	}
	if len(r.Interfaces) == 0 {
		var out []byte
		var err error
		if r.Flavor == "go" {
			out, err = runCmd(6*time.Second, "reticulum-go", "status")
		} else {
			out, err = runCmd(6*time.Second, "rnstatus")
		}
		if err == nil {
			parseReticulumStatus(string(out), r)
			r.Running = true
		}
	}

	if !r.Running && cfg.ifaceCount == 0 {
		// No daemon, no config, nothing worth reporting.
		return nil
	}
	if cfg.ifaceCount > 0 && len(r.Interfaces) == 0 {
		r.Interfaces = make([]RnsInterface, 0)
	}

	// rgoslow surfaces congestion and integrity findings; keep it
	// bounded so a wedged daemon cannot stall the sampler.
	if r.Flavor == "go" && r.Running {
		if out, err := runCmd(6*time.Second, "reticulum-go", "slow"); err == nil {
			r.Findings = parseRnsFindings(string(out), 8)
		}
	}
	return r
}

// procCommRunning scans /proc/*/comm for an exact process name.
func procCommRunning(names ...string) bool {
	entries, err := os.ReadDir(procRoot)
	if err != nil {
		return false
	}
	want := make(map[string]bool, len(names))
	for _, n := range names {
		want[n] = true
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		b, err := os.ReadFile(filepath.Join(procRoot, e.Name(), "comm"))
		if err != nil {
			continue
		}
		if want[strings.TrimSpace(string(b))] {
			return true
		}
	}
	return false
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return strings.TrimSpace(s)
}

// reticulumConfigPaths returns candidate config locations: env
// override first, then the reticulum-go and Python defaults.
func reticulumConfigPaths() []string {
	paths := []string{}
	if v := os.Getenv("WHARFINGER_RETICULUM_CONFIG"); v != "" {
		paths = append(paths, v)
	}
	if home, err := os.UserHomeDir(); err == nil {
		paths = append(paths,
			filepath.Join(home, ".reticulum-go", "config"),
			filepath.Join(home, ".reticulum", "config"))
	}
	return append(paths, "/etc/reticulum/config")
}

// readReticulumConfig loosely parses the INI: [reticulum] scalar keys
// and the count of [[name]] entries under [interfaces].
func readReticulumConfig() reticulumConfig {
	var cfg reticulumConfig
	for _, p := range reticulumConfigPaths() {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		return parseReticulumConfig(string(b))
	}
	return cfg
}

func parseReticulumConfig(data string) reticulumConfig {
	var cfg reticulumConfig
	section := ""
	for _, raw := range strings.Split(data, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[[") && strings.HasSuffix(line, "]]") {
			if section == "interfaces" {
				cfg.ifaceCount++
			}
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.ToLower(strings.TrimSpace(line[1 : len(line)-1]))
			continue
		}
		if section != "reticulum" {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(k))
		val := strings.TrimSpace(v)
		switch key {
		case "enable_control_api":
			cfg.controlAPI = val == "yes" || val == "true" || val == "1" || val == "on"
		case "control_api_host":
			cfg.apiHost = val
		case "control_api_port":
			if n, err := strconv.Atoi(val); err == nil {
				cfg.apiPort = n
			}
		case "rpc_key":
			cfg.rpcKey = val
		}
	}
	return cfg
}

// controlStatus mirrors the fields /v1/status returns per interface;
// extra keys are ignored so additive API changes never break the read.
type controlStatus struct {
	Interfaces []struct {
		Name    string `json:"name"`
		Type    string `json:"type"`
		Status  string `json:"status"`
		Mode    string `json:"mode"`
		Clients int    `json:"clients"`
		RxBytes uint64 `json:"rx_bytes"`
		TxBytes uint64 `json:"tx_bytes"`
	} `json:"interfaces"`
}

type controlHealth struct {
	TransportID string `json:"transport_id"`
	UptimeS     int64  `json:"uptime_s"`
}

func reticulumControlAPI(r *Reticulum, cfg reticulumConfig) error {
	host := cfg.apiHost
	if host == "" {
		host = "127.0.0.1"
	}
	port := cfg.apiPort
	if port == 0 {
		port = 37430
	}
	client := &http.Client{Timeout: 4 * time.Second}
	get := func(path string, dst any) error {
		req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("http://%s:%d%s", host, port, path), nil)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+cfg.rpcKey)
		res, err := client.Do(req)
		if err != nil {
			return err
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			return fmt.Errorf("control api %s: %d", path, res.StatusCode)
		}
		return json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(dst)
	}
	var h controlHealth
	if err := get("/v1/health", &h); err != nil {
		return err
	}
	r.Identity = h.TransportID
	r.UptimeS = h.UptimeS
	var s controlStatus
	if err := get("/v1/status", &s); err != nil {
		return err
	}
	for _, i := range s.Interfaces {
		r.Interfaces = append(r.Interfaces, RnsInterface{
			Name:    i.Name,
			Type:    i.Type,
			Status:  strings.ToLower(i.Status),
			Mode:    i.Mode,
			Clients: i.Clients,
			RxBytes: i.RxBytes,
			TxBytes: i.TxBytes,
		})
	}
	var paths struct {
		Paths []json.RawMessage `json:"paths"`
	}
	if err := get("/v1/paths", &paths); err == nil {
		r.Paths = len(paths.Paths)
	}
	return nil
}

// parseReticulumStatus reads `reticulum-go status` / rnstatus text:
//
//	TCPInterface[Frankfurt/frankfurt.example:4965]
//	   Status  : Up
//	   Mode    : Full
//	   Clients : 0
//	   Traffic : 187.27 KB↑
//	             74.17 KB↓
//	Reticulum Transport Instance <5245a8efe1788c6a70e1> running
func parseReticulumStatus(data string, r *Reticulum) {
	var cur *RnsInterface
	flush := func() {
		if cur != nil {
			r.Interfaces = append(r.Interfaces, *cur)
			cur = nil
		}
	}
	trafficUp := false
	for _, raw := range strings.Split(data, "\n") {
		line := strings.TrimRight(raw, " \t")
		trim := strings.TrimSpace(line)
		if trim == "" {
			continue
		}
		if strings.HasPrefix(trim, "Reticulum Transport Instance") {
			if a := strings.Index(trim, "<"); a >= 0 {
				if b := strings.Index(trim[a:], ">"); b > 0 {
					r.Identity = trim[a+1 : a+b]
				}
			}
			continue
		}
		// Header rows are unindented and end with ']'.
		if !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") &&
			strings.HasSuffix(trim, "]") {
			flush()
			cur = &RnsInterface{}
			if i := strings.Index(trim, "["); i > 0 {
				cur.Type = trim[:i]
				cur.Name = strings.TrimSuffix(trim[i+1:], "]")
			} else {
				cur.Name = strings.TrimSuffix(trim, "]")
			}
			trafficUp = false
			continue
		}
		if cur == nil {
			continue
		}
		k, v, ok := strings.Cut(trim, ":")
		if !ok {
			// The second Traffic line has no key, just "74.17 KB↓".
			if trafficUp {
				cur.RxBytes = parseRnsBytes(trim)
				trafficUp = false
			}
			continue
		}
		v = strings.TrimSpace(v)
		switch strings.ToLower(strings.TrimSpace(k)) {
		case "status":
			cur.Status = strings.ToLower(v)
		case "mode":
			cur.Mode = v
		case "clients", "peers":
			if f := strings.Fields(v); len(f) > 0 {
				if n, err := strconv.Atoi(f[0]); err == nil {
					cur.Clients = n
				}
			}
		case "traffic":
			cur.TxBytes = parseRnsBytes(v)
			trafficUp = true
		}
	}
	flush()
}

// parseRnsBytes converts "187.27 KB↑" style values to bytes. The arrow
// and any trailing label are ignored.
func parseRnsBytes(s string) uint64 {
	s = strings.TrimSpace(s)
	f := strings.Fields(s)
	if len(f) < 2 {
		return 0
	}
	n, err := strconv.ParseFloat(f[0], 64)
	if err != nil {
		return 0
	}
	unit := strings.ToUpper(strings.TrimRight(f[1], "↑↓"))
	mult := map[string]float64{
		"B": 1, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12,
		"KIB": 1024, "MIB": 1024 * 1024, "GIB": 1024 * 1024 * 1024,
	}[unit]
	if mult == 0 {
		return 0
	}
	return uint64(n * mult)
}

// parseRnsFindings keeps nonempty rgoslow output lines, skipping the
// "no findings" style headers, capped so a noisy daemon stays cheap.
func parseRnsFindings(data string, cap int) []string {
	var out []string
	for _, raw := range strings.Split(data, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		low := strings.ToLower(line)
		if strings.HasPrefix(low, "no ") && strings.Contains(low, "finding") {
			continue
		}
		out = append(out, line)
		if len(out) >= cap {
			break
		}
	}
	return out
}
