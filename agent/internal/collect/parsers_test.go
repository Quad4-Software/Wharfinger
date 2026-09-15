package collect

import (
	"math"
	"testing"
)

const statSample = `cpu  2255 34 2290 22625563 6290 127 456 0 0 0
cpu0 1132 34 1441 2831172 3675 127 438 0 0 0
cpu1 1123 0 849 2830439 2614 0 18 0 0 0
intr 2000000
`

func TestParseCPUStat(t *testing.T) {
	agg, cores := parseCPUStat([]byte(statSample))
	if agg.user != 2255 || agg.idle != 22625563 {
		t.Fatalf("aggregate misparsed: %+v", agg)
	}
	if len(cores) != 2 {
		t.Fatalf("expected 2 cores, got %d", len(cores))
	}
}

func TestCPUPctDeltas(t *testing.T) {
	rows1, _ := readCPUStatBytes([]byte(statSample))
	later := `cpu  3255 34 3290 22635563 6290 127 456 0 0 0
cpu0 1632 34 1941 2832172 3675 127 438 0 0 0
cpu1 1623 0 1349 2831439 2614 0 18 0 0 0
`
	rows2, _ := readCPUStatBytes([]byte(later))
	c := cpuMetrics(rows2, rows1, 10)
	// busy delta 2000+2000? user+system grew by 2000 total of 11000 ticks.
	if c.Pct <= 0 || c.Pct > 100 {
		t.Fatalf("pct out of range: %v", c.Pct)
	}
	if len(c.PerCore) != 2 {
		t.Fatalf("per-core mismatch: %v", c.PerCore)
	}
}

func readCPUStatBytes(b []byte) ([]cpuTimes, error) {
	agg, cores := parseCPUStat(b)
	return append([]cpuTimes{agg}, cores...), nil
}

func TestParseMeminfo(t *testing.T) {
	m := parseMeminfo([]byte(`MemTotal:       16384000 kB
MemFree:         4096000 kB
MemAvailable:   12288000 kB
Buffers:          512000 kB
Cached:          2048000 kB
SwapTotal:       2097152 kB
SwapFree:        1048576 kB
`))
	if m["MemTotal"] != 16384000 {
		t.Fatalf("bad MemTotal: %v", m["MemTotal"])
	}
	if m["SwapFree"] != 1048576 {
		t.Fatalf("bad SwapFree: %v", m["SwapFree"])
	}
}

func TestParseMounts(t *testing.T) {
	m := parseMounts([]byte(`sysfs /sys sysfs rw,nosuid 0 0
/dev/sda1 / ext4 rw,relatime 0 0
/dev/sda2 /mnt/my\040dir ext4 rw 0 0
`))
	if len(m) != 3 {
		t.Fatalf("expected 3 mounts, got %d", len(m))
	}
	if m[2][1] != "/mnt/my dir" {
		t.Fatalf("octal unescape failed: %q", m[2][1])
	}
}

func TestSkipDevice(t *testing.T) {
	skip := []string{"loop0", "sda1", "nvme0n1p1", "mmcblk0p2", "dm-0", "zram0", "ram0"}
	keep := []string{"sda", "nvme0n1", "mmcblk0", "vda", "xvdh", "sdb"}
	for _, d := range skip {
		if !skipDevice(d) {
			t.Errorf("expected %q skipped", d)
		}
	}
	for _, d := range keep {
		if skipDevice(d) {
			t.Errorf("expected %q kept", d)
		}
	}
}

func TestParseDiskStats(t *testing.T) {
	m := parseDiskStats([]byte(`   8       0 sda 1234 56 789 10 11 12 13 14 15 16 17
   8       1 sda1 100 0 800 0 0 0 0 0 0 0 0
   7       0 loop0 1 0 8 0 0 0 0 0 0 0 0
`))
	if _, ok := m["sda"]; !ok {
		t.Fatal("sda missing")
	}
	if _, ok := m["sda1"]; ok {
		t.Fatal("partition sda1 should be skipped")
	}
	if _, ok := m["loop0"]; ok {
		t.Fatal("loop0 should be skipped")
	}
}

func TestParseNetDev(t *testing.T) {
	m := parseNetDev([]byte(`Inter-|   Receive                                                |  Transmit
 face |bytes    packets     errs drop fifo frame compressed multicast|bytes    packets
    lo: 1000      10       0    0    0     0          0         0     1000      10
  eth0: 5000      50       0    0    0     0          0         0     3000      30
 veth1234: 9       1       0    0    0     0          0         0        9       1
`))
	if _, ok := m["lo"]; ok {
		t.Fatal("lo should be skipped")
	}
	if _, ok := m["veth1234"]; ok {
		t.Fatal("veth should be skipped")
	}
	if m["eth0"].rx != 5000 || m["eth0"].tx != 3000 {
		t.Fatalf("bad eth0 counters: %+v", m["eth0"])
	}
}

func TestParseNetProtoAndHexIP(t *testing.T) {
	body := `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1
   1: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12346 1
   2: 0100007F:9C40 0200007F:0016 01 00000000:00000000 00:00000000 00000000  1000        0 12347 1`
	s := parseNetProto("tcp", body)
	if len(s) != 3 {
		t.Fatalf("expected 3 sockets, got %d", len(s))
	}
	if s[0].port != 22 || s[0].state != stListen {
		t.Fatalf("bad first socket: %+v", s[0])
	}
	if got := hexToIP("0100007F"); got != "127.0.0.1" {
		t.Fatalf("hexToIP v4: %s", got)
	}
	// ::1 is 15 zero bytes + 01, stored as 4 LE words.
	if got := hexToIP("00000000000000000000000001000000"); got != "::1" && got != "0:0:0:0:0:0:0:1" {
		t.Fatalf("hexToIP v6: %s", got)
	}
}

func TestParseSystemdJSON(t *testing.T) {
	out := parseSystemdJSON([]byte(`[{"unit":"sshd.service","load":"loaded","active":"active","sub":"running"},
{"unit":"cron.service","load":"loaded","active":"active","sub":"running"},
{"unit":"bad.service","load":"loaded","active":"failed","sub":"failed"},
{"unit":"proc.mount","load":"loaded","active":"active","sub":"mounted"}]`))
	if len(out) != 3 {
		t.Fatalf("expected 3 services, got %d", len(out))
	}
	if out[2].State != "failed" {
		t.Fatalf("failed state not propagated: %+v", out[2])
	}
	if out[0].Name != "sshd" {
		t.Fatalf("suffix not trimmed: %s", out[0].Name)
	}
}

func TestParseRcStatus(t *testing.T) {
	out := parseRcStatus(`Runlevel: default
 sshd                  [  started  ]
 cron                  [  stopped  ]
 netmount              [ starting ]
`)
	if len(out) != 3 {
		t.Fatalf("expected 3 services, got %d", len(out))
	}
	if out[0].Name != "sshd" || out[0].State != "active" {
		t.Fatalf("bad sshd row: %+v", out[0])
	}
	if out[1].State != "inactive" {
		t.Fatalf("stopped should map to inactive: %+v", out[1])
	}
}

func TestParseUfw(t *testing.T) {
	u, open := parseUfwStatus(`Status: active
Default: deny (incoming), allow (outgoing), disabled (routed)

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW       Anywhere
443                        ALLOW       Anywhere
22/tcp (v6)                ALLOW       Anywhere (v6)
`)
	if u == nil || !u.Enabled {
		t.Fatal("ufw should be enabled")
	}
	if u.Rules != 3 {
		t.Fatalf("expected 3 rules, got %d", u.Rules)
	}
	if u.Default == "" {
		t.Fatal("default policy missing")
	}
	if u, _ := parseUfwStatus("Status: inactive"); u.Enabled {
		t.Fatal("inactive ufw misparsed")
	}
	// 22/tcp from two rule rows dedupes; bare 443 covers both protos.
	want := map[string]bool{"22/tcp": true, "443/tcp": true, "443/udp": true}
	if len(open) != len(want) {
		t.Fatalf("open ports = %v", open)
	}
	for _, p := range open {
		if !want[p] {
			t.Fatalf("unexpected open port %q", p)
		}
	}
}

func TestUfwRulePorts(t *testing.T) {
	cases := []struct {
		line string
		want []string
	}{
		{"22/tcp                     ALLOW       Anywhere", []string{"22/tcp"}},
		{"80,443/tcp                 ALLOW       Anywhere", []string{"80/tcp", "443/tcp"}},
		{"8080:8090/tcp              ALLOW       Anywhere", []string{"8080-8090/tcp"}},
		{"443                        ALLOW       Anywhere", []string{"443/tcp", "443/udp"}},
		{"53/udp                     ALLOW OUT   Anywhere", nil},
		{"22/tcp                     DENY        Anywhere", nil},
		{"80/tcp                     ALLOW FWD   Anywhere", []string{"80/tcp"}},
		{"Anywhere                   ALLOW       Anywhere", []string{"1-65535/tcp", "1-65535/udp"}},
		// A source-restricted allow does not close the docker bypass.
		{"22/tcp                     ALLOW       10.0.0.1", nil},
		{"Anywhere                   ALLOW       10.0.0.1", nil},
		{"Nginx Full                 ALLOW       Anywhere", nil},
	}
	for _, c := range cases {
		got := ufwRulePorts(c.line)
		if len(got) != len(c.want) {
			t.Fatalf("%q: got %v want %v", c.line, got, c.want)
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Fatalf("%q: got %v want %v", c.line, got, c.want)
			}
		}
	}
}

func TestParseF2b(t *testing.T) {
	jails := parseF2bJails("Status\n|- Number of jail:\t2\n`- Jail list:\tsshd, recidive-bad$name, nginx\n")
	// The jail name with $ is rejected by the identifier check.
	if len(jails) != 2 {
		t.Fatalf("expected 2 valid jails, got %v", jails)
	}
	j := parseF2bJail(`Status for the jail: sshd
|- Banned IP list:	1.2.3.4 2001:db8::1 not-an-ip`)
	if j.Banned != 2 || len(j.BannedIPs) != 2 {
		t.Fatalf("bad jail parse: %+v", j)
	}
}

func TestRound1(t *testing.T) {
	if round1(12.34) != 12.3 {
		t.Fatalf("round1: %v", round1(12.34))
	}
	if math.Abs(round1(0.05)-0.1) > 0.001 {
		t.Fatalf("round1: %v", round1(0.05))
	}
}

func TestParseProcStat(t *testing.T) {
	// Realistic line: comm contains spaces and parens, fields must be
	// split after the last ')'.
	line := "1234 (weird (name) proc) S 1 1234 1234 0 -1 4194304 100 0 0 0 400 200 0 0 20 0 1 0 50 12345678 512 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0\n"
	pid, pt, ok := parseProcStat([]byte(line))
	if !ok {
		t.Fatal("parseProcStat rejected a valid line")
	}
	if pid != 1234 || pt.name != "weird (name) proc" {
		t.Fatalf("pid/name misparsed: %d %q", pid, pt.name)
	}
	// utime 400 + stime 200 ticks; rss 512 pages.
	if pt.total != 600 {
		t.Fatalf("total ticks: got %d want 600", pt.total)
	}
	if pt.rss != 512*uint64(4096) && pt.rss == 0 {
		t.Fatalf("rss misparsed: %d", pt.rss)
	}
	if pt.ppid != 1 {
		t.Fatalf("ppid: got %d want 1", pt.ppid)
	}
}

func TestParseProcStatRejects(t *testing.T) {
	for _, bad := range []string{
		"",
		"1234 no parens",
		"12 (x) S 1", // too few fields
		"abc (x) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22",
	} {
		if _, _, ok := parseProcStat([]byte(bad)); ok {
			t.Fatalf("accepted malformed line %q", bad)
		}
	}
}

func TestProcMetricsRanksAndCaps(t *testing.T) {
	prev := map[int]procTimes{
		1: {name: "idle", total: 100, rss: 1000},
		2: {name: "busy", total: 0, rss: 100},
		3: {name: "gone-later", total: 0, rss: 50},
	}
	cur := map[int]procTimes{
		1: {name: "idle", total: 100, rss: 1000}, // no ticks spent
		2: {name: "busy", total: 500, rss: 100},  // 500 ticks in 5s = 100%
		4: {name: "new", total: 10, rss: 99999},  // no prev: cpu 0, sorts by rss
	}
	got := procMetrics(cur, prev, 5)
	if len(got) != 3 {
		t.Fatalf("expected 3 procs, got %d", len(got))
	}
	if got[0].Name != "busy" || got[0].CPUPct != 100 {
		t.Fatalf("top proc: %+v", got[0])
	}
	// Both remaining procs have cpu 0, so the tie breaks on rss:
	// new (99999) ahead of idle (1000).
	if got[1].Name != "new" || got[1].CPUPct != 0 {
		t.Fatalf("mid proc: %+v", got[1])
	}
	if got[2].Name != "idle" {
		t.Fatalf("tail proc: %+v", got[2])
	}
}
