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
// count separately.
func parseUfwStatus(data string) *UFW {
	lines := strings.Split(data, "\n")
	if len(lines) == 0 {
		return nil
	}
	var u *UFW
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
		}
	}
	return u
}

func ufwStatus() *UFW {
	b, err := runCmd(3*time.Second, "ufw", "status")
	if err != nil {
		return nil // not installed or not permitted
	}
	return parseUfwStatus(string(b))
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
