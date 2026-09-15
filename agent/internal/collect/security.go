package collect

import (
	"net/netip"
	"regexp"
	"strings"
	"time"
)

func securityMetrics() Security {
	return Security{
		UFW:       ufwStatus(),
		Firewalld: firewalldStatus(),
		Fail2ban:  fail2banStatus(),
		CrowdSec:  crowdsecStatus(),
	}
}

// parseUfwStatus reads `ufw status` output. First line carries the
// state; a "Default:" line carries the policy; indented "(v6)" rules
// count separately. Returns the open inbound port set alongside the
// summary so callers can diff it against published container ports.
func parseUfwStatus(data string) (*UFW, []string) {
	lines := strings.Split(data, "\n")
	if len(lines) == 0 {
		return nil, nil
	}
	var u *UFW
	var ports []string
	seen := map[string]bool{}
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if strings.HasPrefix(l, "Status:") {
			u = &UFW{Enabled: strings.TrimSpace(strings.TrimPrefix(l, "Status:")) == "active"}
			continue
		}
		if u == nil {
			continue
		}
		if strings.HasPrefix(l, "Default:") {
			u.Default = strings.TrimSpace(strings.TrimPrefix(l, "Default:"))
		}
		// Rule rows look like "22/tcp ALLOW Anywhere"; skip headers.
		if strings.Contains(l, "ALLOW") || strings.Contains(l, "DENY") ||
			strings.Contains(l, "REJECT") || strings.Contains(l, "LIMIT") {
			u.Rules++
			for _, p := range ufwRulePorts(l) {
				if !seen[p] {
					seen[p] = true
					ports = append(ports, p)
				}
			}
		}
	}
	return u, ports
}

// ufwRulePorts extracts the inbound port/proto tokens a rule line
// opens: "22/tcp ALLOW Anywhere" yields 22/tcp, "80,443/tcp" splits
// into both ports, "8080:8090/tcp" becomes a dash range the shared
// matcher understands. Only ALLOW and LIMIT rows open anything, and
// "OUT" direction rules are egress so they never cover inbound
// published ports.
func ufwRulePorts(line string) []string {
	fields := strings.Fields(strings.ReplaceAll(line, " (v6)", ""))
	if len(fields) < 2 {
		return nil
	}
	verb := -1
	for i, f := range fields {
		switch f {
		case "ALLOW", "LIMIT":
			if verb < 0 {
				verb = i
			}
		case "DENY", "REJECT":
			return nil
		}
	}
	if verb < 0 {
		return nil
	}
	// The column after the verb may carry a direction word; the From
	// column follows it. A rule only covers a published port when it
	// allows inbound from everywhere: a source-restricted allow still
	// leaves docker's accept open to the rest of the world.
	fromIdx := verb + 1
	switch {
	case fromIdx >= len(fields):
		return nil
	case fields[fromIdx] == "OUT":
		return nil
	case fields[fromIdx] == "IN" || fields[fromIdx] == "FWD":
		fromIdx++
	}
	if fromIdx >= len(fields) || fields[fromIdx] != "Anywhere" {
		return nil
	}
	to := fields[0]
	if to == "Anywhere" || to == "any" {
		// A wildcard To opens every port; return ranges that cover all.
		return []string{"1-65535/tcp", "1-65535/udp"}
	}
	parts := strings.Split(to, ",")
	proto := ""
	if i := strings.Index(parts[len(parts)-1], "/"); i >= 0 {
		proto = parts[len(parts)-1][i:]
	}
	var out []string
	for _, p := range parts {
		num := p
		if i := strings.Index(p, "/"); i >= 0 {
			num = p[:i]
		}
		num = strings.ReplaceAll(num, ":", "-")
		if !ufwPortNumRe.MatchString(num) {
			return nil // unparseable To column; treat as covering nothing
		}
		if proto == "" {
			// A bare port in ufw opens both protocols.
			out = append(out, num+"/tcp", num+"/udp")
			continue
		}
		out = append(out, num+proto)
	}
	return out
}

var ufwPortNumRe = regexp.MustCompile(`^[0-9]+(-[0-9]+)?$`)

func ufwStatus() *UFW {
	b, err := runCmd(3*time.Second, "ufw", "status")
	if err != nil {
		return nil // not installed or not permitted
	}
	u, open := parseUfwStatus(string(b))
	if u != nil && u.Enabled {
		u.Bypassed = publishedBypassed(publishedHostPorts(), open)
	}
	return u
}

// jailName must look like a simple identifier before it goes back on
// the fail2ban-client command line; anything else is dropped.
var jailNameRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)

// parseF2bJails extracts the jail list from `fail2ban-client status`:
// "Jail list: sshd, recidive" inside a "- Jail list:" section.
func parseF2bJails(data string) []string {
	for _, line := range strings.Split(data, "\n") {
		line = strings.TrimSpace(line)
		if !strings.Contains(line, "Jail list:") {
			continue
		}
		list := line[strings.Index(line, "Jail list:")+len("Jail list:"):]
		var out []string
		for _, j := range strings.Split(list, ",") {
			j = strings.TrimSpace(j)
			if jailNameRe.MatchString(j) {
				out = append(out, j)
			}
		}
		return out
	}
	return nil
}

// parseF2bJail extracts banned IPs from `fail2ban-client status <jail>`.
func parseF2bJail(data string) F2bJail {
	j := F2bJail{}
	for _, line := range strings.Split(data, "\n") {
		line = strings.TrimSpace(line)
		if !strings.Contains(line, "Banned IP list:") {
			continue
		}
		list := line[strings.Index(line, "Banned IP list:")+len("Banned IP list:"):]
		for _, ip := range strings.Fields(list) {
			if _, err := netip.ParseAddr(ip); err == nil {
				j.BannedIPs = append(j.BannedIPs, ip)
			}
		}
	}
	j.Banned = len(j.BannedIPs)
	return j
}

func fail2banStatus() *Fail2ban {
	b, err := runCmd(4*time.Second, "fail2ban-client", "status")
	if err != nil {
		return nil // absent, not running, or not permitted
	}
	f := &Fail2ban{Enabled: true}
	for _, jail := range parseF2bJails(string(b)) {
		jb, err := runCmd(4*time.Second, "fail2ban-client", "status", jail)
		if err != nil {
			f.Jails = append(f.Jails, F2bJail{Name: jail})
			continue
		}
		j := parseF2bJail(string(jb))
		j.Name = jail
		f.Jails = append(f.Jails, j)
	}
	return f
}
