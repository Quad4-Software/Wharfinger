package collect

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// fwPortRE matches the port/proto tokens firewalld lists under a
// zone's ports: 8080/tcp, 53/udp, or a range like 8000-8100/tcp.
var fwPortRE = regexp.MustCompile(`^[0-9]+(-[0-9]+)?/(tcp|udp|sctp|dccp)$`)

// parseFirewalldZones reads firewall-cmd --list-all-zones output.
// Zone headers are unindented names, optionally suffixed "(active)";
// each "ports:" line carries space-separated port/proto tokens and
// rich rule entries are "rule ..." lines. Ports are deduped across
// zones since the payload reports the open set, not per-zone detail.
func parseFirewalldZones(data string) (zones []string, ports []string, rich int) {
	portSet := map[string]bool{}
	for _, line := range strings.Split(data, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		unindented := len(line) == len(strings.TrimLeft(line, " \t"))
		switch {
		case unindented:
			zones = append(zones, strings.Fields(trimmed)[0])
		case strings.HasPrefix(trimmed, "ports:"):
			for _, tok := range strings.Fields(strings.TrimPrefix(trimmed, "ports:")) {
				if fwPortRE.MatchString(tok) && !portSet[tok] {
					portSet[tok] = true
					ports = append(ports, tok)
				}
			}
		case strings.HasPrefix(trimmed, "rule "):
			rich++
		}
	}
	sort.Strings(ports)
	return zones, ports, rich
}

// fwPortNum parses the leading port number of a port/proto token.
func fwPortNum(tok string) (int, string, bool) {
	num, proto, ok := strings.Cut(tok, "/")
	if !ok {
		return 0, "", false
	}
	n, err := strconv.Atoi(strings.SplitN(num, "-", 2)[0])
	return n, proto, err == nil
}

// fwOpenCovers reports whether the open port set covers a published
// port, honoring ranges like 8000-8100/tcp as well as exact tokens.
func fwOpenCovers(open []string, port string) bool {
	n, proto, ok := fwPortNum(port)
	if !ok {
		return false
	}
	for _, o := range open {
		if o == port {
			return true
		}
		lo, hi, oproto, ok := splitFwRange(o)
		if ok && oproto == proto && n >= lo && n <= hi {
			return true
		}
	}
	return false
}

func splitFwRange(tok string) (int, int, string, bool) {
	num, proto, ok := strings.Cut(tok, "/")
	if !ok {
		return 0, 0, "", false
	}
	lo, hi, ok := strings.Cut(num, "-")
	if !ok {
		return 0, 0, "", false
	}
	l, err1 := strconv.Atoi(lo)
	h, err2 := strconv.Atoi(hi)
	return l, h, proto, err1 == nil && err2 == nil
}

// firewalldBypassed flags published container ports that no zone
// opens. docker and podman program their own NAT rules, so a
// published port bypasses firewalld filtering entirely; reporting
// them makes the gap visible instead of implying the zone set covers
// all listeners.
func firewalldBypassed(published, open []string) []string {
	var out []string
	for _, p := range published {
		if !fwOpenCovers(open, p) {
			out = append(out, p)
		}
	}
	return out
}

// firewalldStatus reports zones, open ports, and rich rule counts
// when firewalld is running. --state answers even when the
// list calls are denied (unprivileged polkit), so a minimal section
// still shows the daemon is up; the detail calls degrade the same
// way the ufw collector degrades.
func firewalldStatus() *Firewalld {
	b, err := runCmd(3*time.Second, "firewall-cmd", "--state")
	if err != nil || strings.TrimSpace(string(b)) != "running" {
		return nil
	}
	f := &Firewalld{Enabled: true}
	if b, err := runCmd(3*time.Second, "firewall-cmd", "--get-default-zone"); err == nil {
		f.Default = strings.TrimSpace(string(b))
	}
	if b, err := runCmd(5*time.Second, "firewall-cmd", "--list-all-zones"); err == nil {
		f.Zones, f.Ports, f.RichRules = parseFirewalldZones(string(b))
	}
	f.Bypassed = firewalldBypassed(publishedHostPorts(), f.Ports)
	return f
}
