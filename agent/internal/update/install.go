package update

import (
	"fmt"
	"os"
	"path/filepath"
)

// checkExe resolves symlinks on exe and refuses anything that is not
// a regular file. Symlink resolution matters: package managers often
// link the real binary, and replacing the link itself would leave the
// target untouched.
func checkExe(exe string) (string, error) {
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	st, err := os.Stat(exe)
	if err != nil {
		return "", err
	}
	if !st.Mode().IsRegular() {
		return "", fmt.Errorf("%s is not a regular file", exe)
	}
	return exe, nil
}

// install replaces exe with bin atomically: write exe.new in the
// same directory, fsync, chmod 0755, then rename over the target.
// An O_EXCL lock file keeps concurrent updates from interleaving and
// doubles as proof the directory is writable (rename needs that).
// On any failure the .new file and the lock are removed, so a
// partial update never lands.
func install(exe string, bin []byte) error {
	exe, err := checkExe(exe)
	if err != nil {
		return err
	}
	lockPath := exe + ".update-lock"
	lock, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
	if err != nil {
		return fmt.Errorf("update lock: %w", err)
	}
	defer os.Remove(lockPath)
	defer lock.Close()

	tmp := exe + ".new"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		return err
	}
	defer os.Remove(tmp) // no-op once the rename lands
	if n, err := f.Write(bin); err != nil || n != len(bin) {
		f.Close()
		return fmt.Errorf("write %s: %v", tmp, err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0755); err != nil {
		return err
	}
	return os.Rename(tmp, exe)
}
