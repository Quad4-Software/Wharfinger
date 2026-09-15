package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// wharfinger-agent firewall closes the docker-iptables gap: docker
// and podman publish container ports through their own NAT and
// DOCKER-USER forward rules ahead of ufw or firewalld, so a
// published port answers the internet even when the firewall denies
// it. The fix inserts a small tagged rule set into DOCKER-USER:
// private sources return early, ufw's forward chain gets first say
// on external traffic (so `ufw route allow` works again), and new
// connections toward private space that no rule claimed are dropped.
// Default prints the plan; -yes applies it as root, -revert deletes
// every rule carrying the tag.

const fwFixTag = "wharfinger-fwfix"

// fwRule is one DOCKER-USER rule. pos > 0 inserts at that chain
// position; pos == 0 appends. Keeping position and spec separate
// makes idempotency checks position-free (-C has no position arg).
type fwRule struct {
	pos  int
	spec []string
}

var fwFixNets = []string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"}

// tagged builds a rule spec: matches first, then the comment match
// and jump target last, since matches must precede -j.
func tagged(jump string, spec ...string) []string {
	return append(append(spec, "-m", "comment", "--comment", fwFixTag), "-j", jump)
}

// fwFixRules builds the ordered rule set. With ufw active the
// ufw-user-forward jump sits between the early returns and the
// drops so `ufw route allow/deny` rules govern docker forwarding
// before the catch-all. Without ufw the drops alone close the hole
// and reopening a port means inserting an ACCEPT ahead of them.
func fwFixRules(ufw bool) []fwRule {
	var out []fwRule
	for i, cidr := range fwFixNets {
		out = append(out, fwRule{
			pos:  i + 1,
			spec: tagged("RETURN", "-s", cidr),
		})
	}
	if ufw {
		out = append(out, fwRule{pos: len(fwFixNets) + 1, spec: tagged("ufw-user-forward")})
	}
	for _, cidr := range fwFixNets {
		out = append(out, fwRule{spec: tagged("DROP",
			"-p", "tcp", "-m", "tcp", "--tcp-flags", "FIN,SYN,RST,ACK", "SYN",
			"-d", cidr)})
	}
	for _, cidr := range fwFixNets {
		out = append(out, fwRule{spec: tagged("DROP", "-p", "udp", "-d", cidr)})
	}
	return out
}

// fwRevertSpecs parses `iptables -S DOCKER-USER` output into the -D
// specs that remove every rule tagged by this tool.
func fwRevertSpecs(saveOutput string) [][]string {
	var out [][]string
	for _, line := range strings.Split(saveOutput, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 || fields[0] != "-A" || fields[1] != "DOCKER-USER" {
			continue
		}
		taggedRule := false
		for _, f := range fields {
			if strings.Trim(f, `"`) == fwFixTag {
				taggedRule = true
				break
			}
		}
		if taggedRule {
			out = append(out, fields[2:])
		}
	}
	return out
}

func iptables(args ...string) error {
	c := exec.Command("iptables", args...)
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	return c.Run()
}

// iptablesPresent reports whether the DOCKER-USER chain exists; it
// only exists when docker has programmed its iptables rules.
func iptablesChainLive() bool {
	return exec.Command("iptables", "-S", "DOCKER-USER").Run() == nil
}

func iptablesRuleExists(spec []string) bool {
	args := append([]string{"-C", "DOCKER-USER"}, spec...)
	return exec.Command("iptables", args...).Run() == nil
}

// ufwActive mirrors the collector's check: ufw status first line.
func ufwActive() bool {
	b, err := exec.Command("ufw", "status").Output()
	if err != nil {
		return false
	}
	for _, l := range strings.Split(string(b), "\n") {
		l = strings.TrimSpace(l)
		if strings.HasPrefix(l, "Status:") {
			return strings.TrimSpace(strings.TrimPrefix(l, "Status:")) == "active"
		}
	}
	return false
}

// runFirewall implements the firewall subcommand. Plan is always
// printed; -yes applies (root only), -revert removes tagged rules.
func runFirewall(args []string) {
	fs := flag.NewFlagSet("wharfinger-agent firewall", flag.ContinueOnError)
	yes := fs.Bool("yes", false, "apply the printed plan (default is a dry-run)")
	revert := fs.Bool("revert", false, "remove all rules tagged "+fwFixTag)
	if err := fs.Parse(args); err != nil {
		os.Exit(2)
	}

	if !iptablesChainLive() {
		fmt.Println("wharfinger-agent firewall: no DOCKER-USER chain; docker is not publishing ports through iptables")
		return
	}
	ufw := ufwActive()

	if *revert {
		if os.Geteuid() != 0 {
			fmt.Fprintln(os.Stderr, "wharfinger-agent firewall: -revert must run as root")
			os.Exit(1)
		}
		b, err := exec.Command("iptables", "-S", "DOCKER-USER").Output()
		if err != nil {
			fmt.Fprintln(os.Stderr, "wharfinger-agent firewall: list rules:", err)
			os.Exit(1)
		}
		specs := fwRevertSpecs(string(b))
		if len(specs) == 0 {
			fmt.Println("no " + fwFixTag + " rules present")
			return
		}
		for _, spec := range specs {
			argv := append([]string{"-D", "DOCKER-USER"}, spec...)
			fmt.Printf("$ iptables %s\n", strings.Join(argv, " "))
			if err := iptables(argv...); err != nil {
				fmt.Fprintln(os.Stderr, "wharfinger-agent firewall: delete failed:", err)
				os.Exit(1)
			}
		}
		fmt.Printf("removed %d %s rules\n", len(specs), fwFixTag)
		return
	}

	rules := fwFixRules(ufw)
	fmt.Println("plan: tag", fwFixTag, "in the DOCKER-USER chain")
	if ufw {
		fmt.Println("ufw is active: docker forwarding is routed through ufw-user-forward so `ufw route allow/deny` governs it")
	} else {
		fmt.Println("ufw inactive or absent: external access to unpublished ports is dropped outright")
	}
	fmt.Println("afterwards: ufw route allow reopens a port; on firewalld use `firewall-cmd --direct --add-rule ipv4 filter DOCKER-USER 0 -p tcp --dport N -j ACCEPT`")
	fmt.Println("caveat: containers also lose outbound access to private/LAN destinations unless a rule allows it")
	for _, r := range rules {
		verb := "-A"
		if r.pos > 0 {
			verb = fmt.Sprintf("-I %d", r.pos)
		}
		fmt.Printf("  iptables %s DOCKER-USER %s\n", verb, strings.Join(r.spec, " "))
	}

	if !*yes {
		fmt.Println("\ndry-run: re-run with -yes to apply")
		return
	}
	if os.Geteuid() != 0 {
		fmt.Fprintln(os.Stderr, "wharfinger-agent firewall: -yes must run as root")
		os.Exit(1)
	}
	for _, r := range rules {
		if iptablesRuleExists(r.spec) {
			fmt.Println("  already present:", strings.Join(r.spec, " "))
			continue
		}
		var argv []string
		if r.pos > 0 {
			argv = []string{"-I", "DOCKER-USER", fmt.Sprint(r.pos)}
		} else {
			argv = []string{"-A", "DOCKER-USER"}
		}
		argv = append(argv, r.spec...)
		fmt.Printf("$ iptables %s\n", strings.Join(argv, " "))
		if err := iptables(argv...); err != nil {
			fmt.Fprintln(os.Stderr, "wharfinger-agent firewall: rule failed:", err)
			os.Exit(1)
		}
	}
	fmt.Println("wharfinger-agent firewall: done")
}
