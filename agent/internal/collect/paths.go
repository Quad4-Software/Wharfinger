package collect

import "os"

// proc/sys roots. In a container the host filesystems mount at
// /host/proc and /host/sys; WHARFINGER_PROC_ROOT and WHARFINGER_SYS_ROOT point
// the collectors there. Bare metal defaults are untouched.
var (
	procRoot = envOr("WHARFINGER_PROC_ROOT", "/proc")
	sysRoot  = envOr("WHARFINGER_SYS_ROOT", "/sys")
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func procFile(name string) string { return procRoot + "/" + name }
func sysFile(name string) string  { return sysRoot + "/" + name }
