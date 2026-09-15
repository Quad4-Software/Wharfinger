// Package collect gathers host metrics into a Payload. Every collector
// degrades gracefully: a missing tool or unreadable /proc entry omits
// the section instead of failing the whole report.
package collect

// AgentVersion is stamped into every payload and the ws handshake.
// Release builds override it via -ldflags -X.
var AgentVersion = "0.1.0"

// Payload is the wire format sent to the hub. Keep the JSON field names
// in sync with the valibot schema in src/lib/server/ingress/schema.ts.
type Payload struct {
	V           int    `json:"v"`
	Fingerprint string `json:"fingerprint"`
	Ts          int64  `json:"ts"`
	// Backfill marks a buffered sample delivered late after a hub
	// outage; the hub relaxes its clock-skew window for these.
	Backfill    bool           `json:"backfill,omitempty"`
	Agent       AgentInfo      `json:"agent"`
	CPU         CPU            `json:"cpu"`
	Mem         Mem            `json:"mem"`
	Disks       []Disk         `json:"disks,omitempty"`
	DiskIO      []DiskIO       `json:"diskIO,omitempty"`
	Temps       []Temp         `json:"temps,omitempty"`
	GPUs        []GPU          `json:"gpus,omitempty"`
	Net         Net            `json:"net"`
	Connections Connections    `json:"connections"`
	Ports       []Port         `json:"ports,omitempty"`
	Docker      *Docker        `json:"docker,omitempty"`
	Services    []ServiceState `json:"services,omitempty"`
	Processes   []Process      `json:"processes,omitempty"`
	Security    Security       `json:"security"`
	K8s         *K8s           `json:"k8s,omitempty"`
	Traefik     *Traefik       `json:"traefik,omitempty"`
	Reticulum   *Reticulum     `json:"reticulum,omitempty"`
	Logins      *Logins        `json:"logins,omitempty"`
	// EdgeCerts is the edge-proxy TLS inventory, populated by main
	// when the -edge server runs. Mirrors edge.CertInfo; kept as a
	// local struct so collect stays a leaf package.
	EdgeCerts []EdgeCert `json:"edgeCerts,omitempty"`
	// Updates is the package posture, cached ~30min; nil when no
	// supported package manager was detected.
	Updates *Updates `json:"updates,omitempty"`
}

// EdgeCert reports one managed certificate; wire-compatible with
// edge.CertInfo and the hub EdgeCertInfo type.
type EdgeCert struct {
	Host      string `json:"host"`
	ExpiresAt int64  `json:"expiresAt"`
	Issuer    string `json:"issuer"`
	Status    string `json:"status"`
}

type AgentInfo struct {
	Version  string `json:"version"`
	Hostname string `json:"hostname"`
	OS       string `json:"os"`
	Arch     string `json:"arch"`
	Kernel   string `json:"kernel,omitempty"`
	UptimeS  int64  `json:"uptimeSec"`
	Name     string `json:"name,omitempty"`
	// Caps advertises protocol features the agent implements so the
	// hub can reason about compat, Beszel-style: a hub that knows a
	// newer wire version can still read the fields it understands.
	Caps []string `json:"caps,omitempty"`
}

// AgentCaps is the capability list reported in every payload. Older
// hubs ignore it; newer hubs can gate features on it.
var AgentCaps = []string{"v1", "backfill", "edge", "self-update", "reticulum", "logins"}

type CPU struct {
	Pct     float64   `json:"pct"`
	Cores   int       `json:"cores"`
	Load1   float64   `json:"load1"`
	Load5   float64   `json:"load5"`
	Load15  float64   `json:"load15"`
	PerCore []float64 `json:"perCore,omitempty"`
	FreqMhz float64   `json:"freqMhz,omitempty"`
}

type Mem struct {
	Total     uint64  `json:"total"`
	Used      uint64  `json:"used"`
	Available uint64  `json:"available"`
	Pct       float64 `json:"pct"`
	SwapTotal uint64  `json:"swapTotal"`
	SwapUsed  uint64  `json:"swapUsed"`
}

type Disk struct {
	Mount     string  `json:"mount"`
	Fstype    string  `json:"fstype"`
	Device    string  `json:"device,omitempty"`
	Total     uint64  `json:"total"`
	Used      uint64  `json:"used"`
	Pct       float64 `json:"pct"`
	InodesPct float64 `json:"inodesPct,omitempty"`
}

type DiskIO struct {
	Device   string  `json:"device"`
	ReadBps  float64 `json:"readBps"`
	WriteBps float64 `json:"writeBps"`
	Util     float64 `json:"util"`
}

type Temp struct {
	Label   string  `json:"label"`
	Celsius float64 `json:"celsius"`
}

type GPU struct {
	Vendor   string  `json:"vendor"`
	Name     string  `json:"name"`
	TempC    float64 `json:"tempC,omitempty"`
	UtilPct  float64 `json:"utilPct,omitempty"`
	MemUsed  uint64  `json:"memUsed,omitempty"`
	MemTotal uint64  `json:"memTotal,omitempty"`
	PowerW   float64 `json:"powerW,omitempty"`
}

type Net struct {
	RxBps      float64    `json:"rxBps"`
	TxBps      float64    `json:"txBps"`
	Interfaces []NetIface `json:"interfaces,omitempty"`
	// Non-loopback unicast addresses on real interfaces; the hub uses
	// them for domain preflight (does DNS point at this machine).
	Addresses []string `json:"addresses,omitempty"`
}

type NetIface struct {
	Name  string  `json:"name"`
	RxBps float64 `json:"rxBps"`
	TxBps float64 `json:"txBps"`
}

type Connections struct {
	Established int `json:"established"`
	Listen      int `json:"listen"`
	TimeWait    int `json:"timeWait"`
	UDP         int `json:"udp"`
	Total       int `json:"total"`
}

type Port struct {
	Proto   string `json:"proto"`
	Port    uint16 `json:"port"`
	Address string `json:"address"`
	Process string `json:"process,omitempty"`
}

type Docker struct {
	Running    int               `json:"running"`
	Total      int               `json:"total"`
	Containers []DockerContainer `json:"containers,omitempty"`
}

type DockerContainer struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Image    string  `json:"image"`
	State    string  `json:"state"`
	Status   string  `json:"status"`
	Runtime  string  `json:"runtime"` // docker | podman
	CPUPct   float64 `json:"cpuPct,omitempty"`
	MemUsed  uint64  `json:"memUsed,omitempty"`
	MemLimit uint64  `json:"memLimit,omitempty"`
	Restarts int     `json:"restarts"`
}

type ServiceState struct {
	Name    string `json:"name"`
	Manager string `json:"manager"` // systemd | openrc
	State   string `json:"state"`   // active|inactive|failed|started|stopped
	Sub     string `json:"sub,omitempty"`
	Enabled *bool  `json:"enabled,omitempty"`
}

type Security struct {
	UFW       *UFW       `json:"ufw,omitempty"`
	Firewalld *Firewalld `json:"firewalld,omitempty"`
	Fail2ban  *Fail2ban  `json:"fail2ban,omitempty"`
	CrowdSec  *CrowdSec  `json:"crowdsec,omitempty"`
}

type UFW struct {
	Enabled bool   `json:"enabled"`
	Default string `json:"default,omitempty"`
	Rules   int    `json:"rules"`
	// Bypassed lists published container ports no inbound ufw rule
	// opens; docker and podman program their own NAT rules and slip
	// past ufw filtering. Only set while ufw is active.
	Bypassed []string `json:"bypassed,omitempty"`
}

// Firewalld mirrors the ufw section for firewalld hosts. A host runs
// either frontend, so both fields coexist as omitempty.
type Firewalld struct {
	Enabled   bool     `json:"enabled"`
	Default   string   `json:"default,omitempty"`
	Zones     []string `json:"zones,omitempty"`
	Ports     []string `json:"ports,omitempty"`
	RichRules int      `json:"richRules"`
	// Bypassed lists published container ports absent from every
	// zone; container runtimes program their own NAT rules and slip
	// past firewalld filtering.
	Bypassed []string `json:"bypassed,omitempty"`
}

type Fail2ban struct {
	Enabled bool      `json:"enabled"`
	Jails   []F2bJail `json:"jails,omitempty"`
}

type F2bJail struct {
	Name      string   `json:"name"`
	Banned    int      `json:"banned"`
	BannedIPs []string `json:"bannedIps,omitempty"`
}

type CrowdSec struct {
	Enabled   bool         `json:"enabled"`
	Decisions int          `json:"decisions"`
	Alerts    int          `json:"alerts"`
	Bans      []CSDecision `json:"bans,omitempty"`
}

type CSDecision struct {
	Scope    string `json:"scope"`
	Value    string `json:"value"`
	Type     string `json:"type"`
	Scenario string `json:"scenario"`
}

type K8s struct {
	Pods      int      `json:"pods"`
	Running   int      `json:"running"`
	Pending   int      `json:"pending"`
	Failed    int      `json:"failed"`
	Succeeded int      `json:"succeeded"`
	Restarts  int      `json:"restarts"`
	PodList   []K8sPod `json:"podList,omitempty"`
}

type K8sPod struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Phase     string `json:"phase"`
	Restarts  int    `json:"restarts"`
}

type Traefik struct {
	HTTPRouters    int `json:"httpRouters"`
	HTTPServices   int `json:"httpServices"`
	Middlewares    int `json:"middlewares"`
	TCPRouters     int `json:"tcpRouters"`
	TCPServices    int `json:"tcpServices"`
	UDPRouters     int `json:"udpRouters"`
	RouterErrors   int `json:"routerErrors"`
	RouterWarnings int `json:"routerWarnings"`
}
