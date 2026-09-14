package collect

import (
	"os"
	"strconv"
	"strings"
)

// parseMeminfo parses /proc/meminfo into kB values keyed by name.
func parseMeminfo(data []byte) map[string]uint64 {
	m := make(map[string]uint64)
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		v, err := strconv.ParseUint(f[1], 10, 64)
		if err != nil {
			continue
		}
		m[strings.TrimSuffix(f[0], ":")] = v
	}
	return m
}

func memMetrics() Mem {
	b, err := os.ReadFile(procFile("meminfo"))
	if err != nil {
		return Mem{}
	}
	m := parseMeminfo(b)
	kb := func(k string) uint64 { return m[k] * 1024 }
	total := kb("MemTotal")
	avail := kb("MemAvailable")
	if avail == 0 {
		// Kernels before 3.14 lack MemAvailable; approximate.
		avail = kb("MemFree") + kb("Buffers") + kb("Cached")
	}
	used := uint64(0)
	if total > avail {
		used = total - avail
	}
	var pct float64
	if total > 0 {
		pct = round1(100 * float64(used) / float64(total))
	}
	return Mem{
		Total:     total,
		Used:      used,
		Available: avail,
		Pct:       pct,
		SwapTotal: kb("SwapTotal"),
		SwapUsed:  kb("SwapTotal") - kb("SwapFree"),
	}
}
