package collect

import (
	"os"
	"strings"
	"sync"
	"time"
)

// Updates is the OS package posture: which manager the host uses,
// how many updates are pending, how many are security updates, and
// whether the distro asks for a reboot. Manager detection order
// matches install prevalence on supported hosts.
type Updates struct {
	Manager        string `json:"manager"`
	Pending        int    `json:"pending"`
	Security       int    `json:"security"`
	RebootRequired *bool  `json:"rebootRequired,omitempty"`
}

// updatesTTL bounds how often the package manager is queried; the
// commands below run package indexes and cost far too much to run on
// every metrics sample.
const updatesTTL = 30 * time.Minute

var updatesCache struct {
	sync.Mutex
	at   time.Time
	data *Updates
}

// updateMetrics returns the cached posture when fresh enough. A nil
// result means no supported package manager was detected.
func updateMetrics() *Updates {
	updatesCache.Lock()
	defer updatesCache.Unlock()
	if updatesCache.data != nil && time.Since(updatesCache.at) < updatesTTL {
		return updatesCache.data
	}
	updatesCache.data = probeUpdates()
	updatesCache.at = time.Now()
	return updatesCache.data
}

// probeUpdates runs the manager-specific dry queries. Every probe is
// read-only (simulation or list flags); index refreshes are left to
// the packages.refresh task so a metrics pass never mutates state.
func probeUpdates() *Updates {
	for _, p := range []func() *Updates{aptUpdates, dnfUpdates, apkUpdates, pacmanUpdates, zypperUpdates} {
		if u := p(); u != nil {
			return u
		}
	}
	return nil
}

// pathExists reports whether a binary resolves in the fixed sbin/bin
// dirs (resolveBin returns the bare name unchanged when not found).
func pathExists(name string) bool {
	_, err := os.Stat(resolveBin(name))
	return err == nil
}

// apt: simulation upgrade counts Inst lines; the upgradable list
// names the pocket, so -security entries give the security count.
func aptUpdates() *Updates {
	if !pathExists("apt-get") {
		return nil
	}
	u := &Updates{Manager: "apt", RebootRequired: rebootRequiredFlag()}
	out, err := runCmd(20*time.Second, "apt-get", "-s", "upgrade")
	if err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			if strings.HasPrefix(line, "Inst ") {
				u.Pending++
			}
		}
	}
	if list, err := runCmd(20*time.Second, "apt", "list", "--upgradable"); err == nil {
		for _, line := range strings.Split(string(list), "\n") {
			if strings.Contains(line, "-security/") {
				u.Security++
			}
		}
	}
	return u
}

// dnf: check-update exits 100 when updates exist; --security limits
// the same listing to security advisories.
func dnfUpdates() *Updates {
	if !pathExists("dnf") {
		return nil
	}
	u := &Updates{Manager: "dnf", RebootRequired: rebootRequiredFlag()}
	out, _ := runCmd(30*time.Second, "dnf", "-q", "check-update")
	u.Pending = countUpdateLines(string(out))
	out, _ = runCmd(30*time.Second, "dnf", "-q", "check-update", "--security")
	u.Security = countUpdateLines(string(out))
	return u
}

// countUpdateLines counts "name version repo" rows in check-update
// output, skipping blank lines and banner rows whose first word is
// prose rather than a package name.
func countUpdateLines(out string) int {
	n := 0
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) >= 3 && !bannerWord[f[0]] {
			n++
		}
	}
	return n
}

// bannerWord lists first-column words that start banner rows in
// dnf/apk/zypper listings rather than a package name.
var bannerWord = map[string]bool{
	"Last":       true, // "Last metadata expiration check: ..."
	"Security":   true,
	"Update":     true,
	"Obsoleting": true,
	"Available":  true,
	"Listing":    true,
}

// apk: apk version -l '<' lists installed packages behind the index.
func apkUpdates() *Updates {
	if !pathExists("apk") {
		return nil
	}
	u := &Updates{Manager: "apk", RebootRequired: rebootRequiredFlag()}
	if out, err := runCmd(15*time.Second, "apk", "version", "-l", "<"); err == nil {
		u.Pending = countUpdateLines(string(out))
	}
	return u
}

// pacman: -Qu lists queued updates without touching the sync db.
func pacmanUpdates() *Updates {
	if !pathExists("pacman") {
		return nil
	}
	u := &Updates{Manager: "pacman", RebootRequired: rebootRequiredFlag()}
	if out, err := runCmd(15*time.Second, "pacman", "-Qu"); err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			if len(strings.Fields(line)) >= 2 {
				u.Pending++
			}
		}
	}
	return u
}

// zypper: list-updates prints a table; data rows have a | separator.
func zypperUpdates() *Updates {
	if !pathExists("zypper") {
		return nil
	}
	u := &Updates{Manager: "zypper", RebootRequired: rebootRequiredFlag()}
	if out, err := runCmd(30*time.Second, "zypper", "-q", "list-updates"); err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			f := strings.Split(line, "|")
			if len(f) >= 4 && strings.TrimSpace(f[0]) != "" && strings.Contains(line, "|") {
				u.Pending++
			}
		}
	}
	return u
}

// rebootRequiredFlag reads the distro reboot markers where they
// exist. A nil pointer means the host gives no signal (non-deb/rpm
// distros), which the panel renders as unknown rather than clean.
func rebootRequiredFlag() *bool {
	for _, f := range []string{
		"/var/run/reboot-required",
		"/run/reboot-required",
	} {
		if _, err := os.Stat(f); err == nil {
			return boolPtr(true)
		}
	}
	// dnf hosts: needs-restarting -r exits 1 when a reboot is needed.
	if pathExists("needs-restarting") {
		_, err := runCmd(15*time.Second, "needs-restarting", "-r")
		if err != nil {
			return boolPtr(true)
		}
		return boolPtr(false)
	}
	if pathExists("apt-get") {
		// deb hosts without the flag file are known-clean.
		return boolPtr(false)
	}
	return nil
}

func boolPtr(b bool) *bool { return &b }
