package state

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
)

// PermIssues reports secret files that are group- or other-accessible
// (any of mode 0077). Empty paths and files that do not exist yet are
// skipped. Nothing is chmodded: findings are returned for the caller
// to log loudly or, under -strict-perms, to refuse startup.
func PermIssues(paths ...string) []string {
	var out []string
	for _, p := range paths {
		if p == "" {
			continue
		}
		fi, err := os.Stat(p)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			out = append(out, fmt.Sprintf("%s: cannot stat: %v", p, err))
			continue
		}
		if fi.Mode().Perm()&0o077 != 0 {
			kind := "file"
			if fi.IsDir() {
				kind = "directory"
			}
			out = append(out, fmt.Sprintf(
				"%s %s is group/other accessible (mode %04o); restrict it to owner-only (chmod go-rwx)",
				kind, p, fi.Mode().Perm()))
		}
	}
	return out
}
