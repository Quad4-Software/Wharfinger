// Package deploy executes deploy jobs claimed from the hub queue
// against the local container runtime. Every external command runs
// with fixed argv through CmdRunner; nothing here builds shell
// strings.
package deploy

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// resolveBin prefers absolute paths in root-owned directories so a
// poisoned PATH cannot redirect execution. Same policy as the
// collectors in internal/collect, duplicated because that helper is
// package-private and this package must not reach into collector
// internals.
var binCache sync.Map

func resolveBin(name string) string {
	if v, ok := binCache.Load(name); ok {
		return v.(string)
	}
	p := name
	for _, dir := range []string{
		"/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin",
	} {
		cand := dir + "/" + name
		if st, err := os.Stat(cand); err == nil && !st.IsDir() {
			p = cand
			break
		}
	}
	binCache.Store(name, p)
	return p
}

// secureJoin joins base and rel and requires the result to stay
// under base. Spec-controlled paths (build context, dockerfile) are
// attacker-influenceable through the hub, so they must never escape
// the checkout directory.
func secureJoin(base, rel string) (string, error) {
	if rel == "" {
		return base, nil
	}
	joined := filepath.Clean(filepath.Join(base, rel))
	if joined != base && !strings.HasPrefix(joined, base+string(os.PathSeparator)) {
		return "", fmt.Errorf("path %q escapes %s", rel, base)
	}
	return joined, nil
}

// underDir resolves p relative to base and requires the result to
// stay under base. Used for env files and deploy keys: the hub names
// the file, the state dir owns the material, and paths pointing
// elsewhere are rejected outright.
func underDir(base, p string) (string, error) {
	if p == "" {
		return "", nil
	}
	abs := p
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(base, p)
	}
	abs = filepath.Clean(abs)
	if abs != base && !strings.HasPrefix(abs, base+string(os.PathSeparator)) {
		return "", fmt.Errorf("path %q is outside the state dir", p)
	}
	return abs, nil
}
