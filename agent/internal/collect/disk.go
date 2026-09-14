package collect

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

// Pseudo and container filesystems that carry no capacity signal.
var skipFstypes = map[string]bool{
	"proc": true, "sysfs": true, "devfs": true, "devtmpfs": true,
	"tmpfs": true, "devpts": true, "cgroup": true, "cgroup2": true,
	"pstore": true, "securityfs": true, "debugfs": true, "tracefs": true,
	"configfs": true, "fusectl": true, "mqueue": true, "hugetlbfs": true,
	"rpc_pipefs": true, "overlay": true, "squashfs": true, "ramfs": true,
	"autofs": true, "binfmt_misc": true, "efivarfs": true, "bpf": true,
	"nsfs": true, "selinuxfs": true, "smackfs": true, "fuse.gvfsd-fuse": true,
}

// mountUnescape rewrites octal escapes like \040 in /proc/mounts
// fields. Package level so the replacer is built once.
var mountUnescape = strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`)

// parseMounts extracts (device, mountpoint, fstype) rows from
// /proc/mounts content, unescaping octal sequences like \040.
func parseMounts(data []byte) [][3]string {
	var out [][3]string
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) < 3 {
			continue
		}
		out = append(out, [3]string{mountUnescape.Replace(f[0]), mountUnescape.Replace(f[1]), f[2]})
	}
	return out
}

func diskMetrics() []Disk {
	b, err := os.ReadFile(procFile("mounts"))
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var out []Disk
	for _, m := range parseMounts(b) {
		dev, mount, fs := m[0], m[1], m[2]
		if skipFstypes[fs] || seen[mount] || !strings.HasPrefix(dev, "/") {
			continue
		}
		seen[mount] = true
		var st syscall.Statfs_t
		if err := syscall.Statfs(mount, &st); err != nil {
			continue // mount vanished or restricted; skip rather than fail
		}
		total := st.Blocks * uint64(st.Bsize)
		free := st.Bfree * uint64(st.Bsize)
		used := total - free
		var pct float64
		if total > 0 {
			pct = round1(100 * float64(used) / float64(total))
		}
		var ipct float64
		if st.Files > 0 {
			ipct = round1(100 * float64(st.Files-st.Ffree) / float64(st.Files))
		}
		out = append(out, Disk{
			Mount:     mount,
			Fstype:    fs,
			Device:    dev,
			Total:     total,
			Used:      used,
			Pct:       pct,
			InodesPct: ipct,
		})
	}
	return out
}

// ioCounters is one row of /proc/diskstats.
type ioCounters struct {
	readSectors, writeSectors, ioMs uint64
}

// parseDiskStats parses /proc/diskstats. Fields per kernel docs:
// name, reads completed, reads merged, sectors read, ms reading,
// writes completed, writes merged, sectors written, ms writing,
// ios in progress, ms doing io, weighted ms.
func parseDiskStats(data []byte) map[string]ioCounters {
	out := make(map[string]ioCounters)
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) < 11 {
			continue
		}
		name := f[2]
		if skipDevice(name) {
			continue
		}
		rs, _ := strconv.ParseUint(f[5], 10, 64)
		ws, _ := strconv.ParseUint(f[9], 10, 64)
		ms, _ := strconv.ParseUint(f[12], 10, 64)
		out[name] = ioCounters{readSectors: rs, writeSectors: ws, ioMs: ms}
	}
	return out
}

// skipDevice drops partitions, loop devices, dm nodes, and ram disks;
// the charts only want whole physical devices.
func skipDevice(name string) bool {
	if strings.HasPrefix(name, "loop") || strings.HasPrefix(name, "ram") ||
		strings.HasPrefix(name, "dm-") || strings.HasPrefix(name, "zram") ||
		strings.HasPrefix(name, "md") {
		return true
	}
	// nvme0n1p1 / mmcblk0p1 partitions end in pN; sda1 ends in a digit.
	if strings.HasPrefix(name, "nvme") || strings.HasPrefix(name, "mmcblk") {
		if i := strings.LastIndex(name, "p"); i > 0 {
			if _, err := strconv.Atoi(name[i+1:]); err == nil {
				return true
			}
		}
		return false
	}
	last := name[len(name)-1]
	return last >= '0' && last <= '9'
}

func readDiskStats() (map[string]ioCounters, error) {
	b, err := os.ReadFile(procFile("diskstats"))
	if err != nil {
		return nil, err
	}
	return parseDiskStats(b), nil
}

func diskIOMetrics(cur, prev map[string]ioCounters, elapsed float64) []DiskIO {
	if elapsed <= 0 || len(prev) == 0 {
		return nil
	}
	const sector = 512.0
	var out []DiskIO
	for dev, c := range cur {
		p, ok := prev[dev]
		if !ok {
			continue
		}
		out = append(out, DiskIO{
			Device:   dev,
			ReadBps:  round1(float64(c.readSectors-p.readSectors) * sector / elapsed),
			WriteBps: round1(float64(c.writeSectors-p.writeSectors) * sector / elapsed),
			Util:     round1(float64(c.ioMs-p.ioMs) / (10 * elapsed)), // ms per second -> %
		})
	}
	return out
}
