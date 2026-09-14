package collect

import (
	"os"
	"runtime"
	"sync"
	"time"

	"github.com/Quad4-Software/Wharfinger/agent/internal/fingerprint"
)

// Sampler holds the previous counter snapshot so rate metrics
// (cpu %, bytes/s) can be computed between collects.
type Sampler struct {
	name    string
	version string
	mu      sync.Mutex
	prev    sampleStamp
	hasPrev bool
}

type sampleStamp struct {
	at    time.Time
	cpu   []cpuTimes
	iface map[string]ifaceCounters
	io    map[string]ioCounters
	procs map[int]procTimes
}

// NewSampler returns a sampler that reports the given display name and
// agent version in each payload.
func NewSampler(name, version string) *Sampler {
	return &Sampler{name: name, version: version}
}

// Collect gathers a full payload. Concurrent calls are serialized so
// rate math always sees a consistent previous sample.
func (s *Sampler) Collect() *Payload {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	cpuRows, _ := readCPUStat()
	ifaces, _ := readNetDev()
	ioRows, _ := readDiskStats()
	procStats := readProcStats()
	// One socket scan feeds both the connection counts and the
	// listener list; they used to read and parse all four
	// /proc/net/* files independently per sample.
	socks := readAllSockets()

	var elapsed float64
	var prev sampleStamp
	if s.hasPrev {
		prev = s.prev
		elapsed = now.Sub(prev.at).Seconds()
	}
	s.prev = sampleStamp{at: now, cpu: cpuRows, iface: ifaces, io: ioRows, procs: procStats}
	s.hasPrev = true

	host, _ := os.Hostname()
	p := &Payload{
		V:           1,
		Fingerprint: fingerprint.Get(),
		Ts:          now.UnixMilli(),
		Agent: AgentInfo{
			Version:  s.version,
			Hostname: host,
			OS:       runtime.GOOS,
			Arch:     runtime.GOARCH,
			Kernel:   kernelRelease(),
			UptimeS:  uptimeSeconds(),
			Name:     s.name,
			Caps:     AgentCaps,
		},
		CPU:         cpuMetrics(cpuRows, prev.cpu, elapsed),
		Mem:         memMetrics(),
		Disks:       diskMetrics(),
		DiskIO:      diskIOMetrics(ioRows, prev.io, elapsed),
		Temps:       tempMetrics(),
		GPUs:        gpuMetrics(),
		Net:         netMetrics(ifaces, prev.iface, elapsed),
		Connections: connectionMetrics(socks),
		Ports:       portMetrics(socks),
		Docker:      dockerMetrics(),
		Services:    serviceMetrics(),
		Processes:   procMetrics(procStats, prev.procs, elapsed),
		Security:    securityMetrics(),
		K8s:         k8sMetrics(),
		Traefik:     traefikMetrics(),
		Reticulum:   reticulumMetrics(),
		Logins:      loginsMetrics(),
	}
	return p
}
