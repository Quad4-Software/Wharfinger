package collect

import (
	"net"
	"os"
	"sort"
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

// ifAddrs is one interface's address list; the indirection exists so
// tests can feed synthetic addrs without touching netlink.
type ifAddrs struct {
	name  string
	addrs []net.Addr
}

var listIfaceAddrs = func() ([]ifAddrs, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	out := make([]ifAddrs, 0, len(ifaces))
	for _, ifi := range ifaces {
		addrs, err := ifi.Addrs()
		if err != nil {
			continue
		}
		out = append(out, ifAddrs{name: ifi.Name, addrs: addrs})
	}
	return out, nil
}

// collectIfaceAddrs keeps non-loopback, non-link-local unicast
// addresses on real interfaces (same skip list as the byte
// counters). Sorted and capped so the payload stays stable and
// bounded.
func collectIfaceAddrs(list []ifAddrs) []string {
	out := make([]string, 0, 16)
	for _, ifi := range list {
		if skipIfaces[ifi.name] || strings.HasPrefix(ifi.name, "veth") ||
			strings.HasPrefix(ifi.name, "docker") || strings.HasPrefix(ifi.name, "br-") ||
			strings.HasPrefix(ifi.name, "virbr") || strings.HasPrefix(ifi.name, "zt") {
			continue
		}
		for _, a := range ifi.addrs {
			var ip net.IP
			switch t := a.(type) {
			case *net.IPNet:
				ip = t.IP
			case *net.IPAddr:
				ip = t.IP
			}
			if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() ||
				ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
				continue
			}
			out = append(out, ip.String())
		}
	}
	sort.Strings(out)
	if len(out) > 64 {
		out = out[:64]
	}
	return out
}

func ifaceAddrs() []string {
	list, err := listIfaceAddrs()
	if err != nil {
		return nil
	}
	return collectIfaceAddrs(list)
}

func netMetrics(cur, prev map[string]ifaceCounters, elapsed float64) Net {
	n := Net{Addresses: ifaceAddrs()}
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
