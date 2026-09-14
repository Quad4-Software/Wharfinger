package collect

import (
	"os"
	"strconv"
	"strings"
)

// ifaceCounters is one row of /proc/net/dev (bytes only).
type ifaceCounters struct {
	rx, tx uint64
}

var skipIfaces = map[string]bool{
	"lo": true,
}

// parseNetDev parses /proc/net/dev content. Only real interfaces are
// kept: veth/docker/bridge noise is dropped like Beszel does.
func parseNetDev(data []byte) map[string]ifaceCounters {
	out := make(map[string]ifaceCounters)
	for _, line := range strings.Split(string(data), "\n") {
		i := strings.Index(line, ":")
		if i < 0 {
			continue
		}
		name := strings.TrimSpace(line[:i])
		if skipIfaces[name] || strings.HasPrefix(name, "veth") ||
			strings.HasPrefix(name, "docker") || strings.HasPrefix(name, "br-") ||
			strings.HasPrefix(name, "virbr") || strings.HasPrefix(name, "zt") {
			continue
		}
		f := strings.Fields(line[i+1:])
		if len(f) < 9 {
			continue
		}
		rx, _ := strconv.ParseUint(f[0], 10, 64)
		tx, _ := strconv.ParseUint(f[8], 10, 64)
		out[name] = ifaceCounters{rx: rx, tx: tx}
	}
	return out
}

func readNetDev() (map[string]ifaceCounters, error) {
	b, err := os.ReadFile(procFile("net/dev"))
	if err != nil {
		return nil, err
	}
	return parseNetDev(b), nil
}

func netMetrics(cur, prev map[string]ifaceCounters, elapsed float64) Net {
	n := Net{}
	for name, c := range cur {
		var rxBps, txBps float64
		if p, ok := prev[name]; ok && elapsed > 0 {
			rxBps = round1(float64(c.rx-min64(c.rx, p.rx)) / elapsed)
			txBps = round1(float64(c.tx-min64(c.tx, p.tx)) / elapsed)
		}
		n.Interfaces = append(n.Interfaces, NetIface{Name: name, RxBps: rxBps, TxBps: txBps})
		n.RxBps += rxBps
		n.TxBps += txBps
	}
	n.RxBps = round1(n.RxBps)
	n.TxBps = round1(n.TxBps)
	return n
}
