// Package fingerprint derives a stable machine identity, matching the
// Beszel model: a hash of host-unique identifiers that locks an agent
// registration to one machine. Raw identifiers never leave the host.
package fingerprint

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strings"
	"sync"
)

// Sources tried in order; the first readable one wins. machine-id is
// stable across reboots and unique per install; the hostname salts it
// so a cloned machine-id still differs per host.
var machineIDPaths = []string{
	"/etc/machine-id",
	"/var/lib/dbus/machine-id",
}

func machineID() string {
	for _, p := range machineIDPaths {
		if b, err := os.ReadFile(p); err == nil {
			if id := strings.TrimSpace(string(b)); id != "" {
				return id
			}
		}
	}
	return ""
}

// Get returns the hex sha256 fingerprint, or "" when no stable host
// identifier exists (exotic containers). The hub treats an empty
// fingerprint as unverifiable and skips binding. The inputs are
// fixed for the process lifetime, so the result is computed once.
var (
	fpOnce sync.Once
	fpVal  string
)

func Get() string {
	fpOnce.Do(func() {
		id := machineID()
		host, _ := os.Hostname()
		if id == "" && host == "" {
			return
		}
		sum := sha256.Sum256([]byte("wharfinger-agent\x00" + id + "\x00" + host))
		fpVal = hex.EncodeToString(sum[:])
	})
	return fpVal
}
