package collect

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// cpuTimes is one row of /proc/stat jiffies.
type cpuTimes struct {
	user, nice, system, idle, iowait, irq, softirq, steal uint64
}

func (c cpuTimes) total() uint64 {
	return c.user + c.nice + c.system + c.idle + c.iowait + c.irq + c.softirq + c.steal
}

func (c cpuTimes) busy() uint64 {
	return c.total() - c.idle - c.iowait
}

// parseCPUStat parses /proc/stat content. The first "cpu" row is the
// aggregate; cpuN rows are per-core. Malformed lines are skipped.
func parseCPUStat(data []byte) (aggregate cpuTimes, cores []cpuTimes) {
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) < 5 || !strings.HasPrefix(f[0], "cpu") {
			continue
		}
		// Stack array instead of a per-line pointer slice: /proc/stat
		// is parsed every sample.
		var v [8]uint64
		var n int
		for i := 1; i < len(f) && n < len(v); i++ {
			x, err := strconv.ParseUint(f[i], 10, 64)
			if err != nil {
				break
			}
			v[n] = x
			n++
		}
		t := cpuTimes{v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]}
		if f[0] == "cpu" {
			aggregate = t
		} else {
			cores = append(cores, t)
		}
	}
	return aggregate, cores
}

func readCPUStat() ([]cpuTimes, error) {
	b, err := os.ReadFile(procFile("stat"))
	if err != nil {
		return nil, err
	}
	agg, cores := parseCPUStat(b)
	return append([]cpuTimes{agg}, cores...), nil
}

func cpuMetrics(rows, prev []cpuTimes, elapsed float64) CPU {
	c := CPU{Cores: max(0, len(rows)-1)}
	if elapsed > 0 && len(prev) > 0 && len(rows) > 0 {
		if d := rows[0].total() - prev[0].total(); d > 0 {
			c.Pct = round1(100 * float64(rows[0].busy()-min64(rows[0].busy(), prev[0].busy())) / float64(d))
		}
		c.PerCore = make([]float64, 0, len(rows)-1)
		for i := 1; i < len(rows) && i < len(prev); i++ {
			d := rows[i].total() - prev[i].total()
			if d == 0 {
				c.PerCore = append(c.PerCore, 0)
				continue
			}
			busy := rows[i].busy() - min64(rows[i].busy(), prev[i].busy())
			c.PerCore = append(c.PerCore, round1(100*float64(busy)/float64(d)))
		}
	}
	if l1, l5, l15 := loadAvg(); true {
		c.Load1, c.Load5, c.Load15 = l1, l5, l15
	}
	c.FreqMhz = avgCPUFreq()
	return c
}

func loadAvg() (float64, float64, float64) {
	b, err := os.ReadFile(procFile("loadavg"))
	if err != nil {
		return 0, 0, 0
	}
	f := strings.Fields(string(b))
	if len(f) < 3 {
		return 0, 0, 0
	}
	l1, _ := strconv.ParseFloat(f[0], 64)
	l5, _ := strconv.ParseFloat(f[1], 64)
	l15, _ := strconv.ParseFloat(f[2], 64)
	return l1, l5, l15
}

// avgCPUFreq averages cpufreq scaling_cur_freq across cores (kHz -> MHz).
func avgCPUFreq() float64 {
	matches, _ := filepath.Glob(sysFile("devices/system/cpu/cpu[0-9]*/cpufreq/scaling_cur_freq"))
	var sum float64
	var n int
	for _, m := range matches {
		b, err := os.ReadFile(m)
		if err != nil {
			continue
		}
		khz, err := strconv.ParseFloat(strings.TrimSpace(string(b)), 64)
		if err != nil {
			continue
		}
		sum += khz / 1000
		n++
	}
	if n == 0 {
		return 0
	}
	return sum / float64(n)
}

func uptimeSeconds() int64 {
	b, err := os.ReadFile(procFile("uptime"))
	if err != nil {
		return 0
	}
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0
	}
	up, _ := strconv.ParseFloat(f[0], 64)
	return int64(up)
}

func kernelRelease() string {
	var u syscall.Utsname
	if err := syscall.Uname(&u); err != nil {
		return ""
	}
	var b strings.Builder
	for _, c := range u.Release {
		if c == 0 {
			break
		}
		b.WriteByte(byte(c))
	}
	return b.String()
}

func round1(v float64) float64 {
	return float64(int(v*10+0.5)) / 10
}

func min64(a, b uint64) uint64 {
	if a < b {
		return a
	}
	return b
}
