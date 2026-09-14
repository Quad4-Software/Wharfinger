package collect

import (
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
)

// /proc stat utime/stime are counted in USER_HZ ticks, 100 on every
// supported Linux platform.
const clockTicksPerSec = 100.0

const maxProcs = 10

// pageSize is fixed for the process lifetime; getpagesize per
// /proc/<pid>/stat row was needlessly a syscall per process.
var pageSize = uint64(os.Getpagesize())

type Process struct {
	Pid      int     `json:"pid"`
	Name     string  `json:"name"`
	CPUPct   float64 `json:"cpuPct"`
	MemBytes uint64  `json:"memBytes"`
}

type procTimes struct {
	name  string
	ppid  int
	total uint64 // utime + stime ticks
	rss   uint64 // bytes
}

// parseProcStat parses /proc/<pid>/stat. comm may itself contain
// spaces and parentheses, so fields are split after the LAST ')'.
// Field numbers follow proc_pid_stat: state is field 3, utime 14,
// stime 15, rss 24; with f[0] = state, field N maps to f[N-3].
func parseProcStat(b []byte) (int, procTimes, bool) {
	s := strings.TrimSpace(string(b))
	open := strings.IndexByte(s, '(')
	cls := strings.LastIndexByte(s, ')')
	if open <= 0 || cls < 0 || cls < open {
		return 0, procTimes{}, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(s[:open]))
	if err != nil {
		return 0, procTimes{}, false
	}
	f := strings.Fields(s[cls+1:])
	if len(f) < 22 {
		return 0, procTimes{}, false
	}
	ppid, _ := strconv.Atoi(f[1])
	utime, _ := strconv.ParseUint(f[11], 10, 64)
	stime, _ := strconv.ParseUint(f[12], 10, 64)
	rssPages, _ := strconv.ParseInt(f[21], 10, 64)
	if rssPages < 0 {
		rssPages = 0
	}
	return pid, procTimes{
		name:  s[open+1 : cls],
		ppid:  ppid,
		total: utime + stime,
		rss:   uint64(rssPages) * pageSize,
	}, true
}

func readProcStats() map[int]procTimes {
	procs := make(map[int]procTimes)
	entries, err := os.ReadDir(procRoot)
	if err != nil {
		return procs
	}
	for _, e := range entries {
		if !e.IsDir() || e.Name()[0] < '0' || e.Name()[0] > '9' {
			continue
		}
		b, err := os.ReadFile(procFile(e.Name() + "/stat"))
		if err != nil {
			continue // process exited between readdir and read
		}
		pid, pt, ok := parseProcStat(b)
		if !ok {
			continue
		}
		if pt.ppid == 2 {
			continue // kernel threads are children of kthreadd
		}
		procs[pid] = pt
	}
	return procs
}

// procMetrics returns the top processes by recent CPU use; on the
// first sample there are no deltas so sorting falls back to RSS.
func procMetrics(cur, prev map[int]procTimes, elapsed float64) []Process {
	out := make([]Process, 0, len(cur))
	for pid, c := range cur {
		var cpu float64
		if p, ok := prev[pid]; ok && elapsed > 0 && c.total >= p.total {
			cpu = float64(c.total-p.total) / clockTicksPerSec / elapsed * 100
		}
		out = append(out, Process{
			Pid:      pid,
			Name:     c.name,
			CPUPct:   math.Round(cpu*10) / 10,
			MemBytes: c.rss,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CPUPct != out[j].CPUPct {
			return out[i].CPUPct > out[j].CPUPct
		}
		return out[i].MemBytes > out[j].MemBytes
	})
	if len(out) > maxProcs {
		out = out[:maxProcs]
	}
	return out
}
