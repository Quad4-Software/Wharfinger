package collect

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// TCP/UDP socket states from include/net/tcp_states.h.
const (
	stEstablished = "01"
	stListen      = "0A"
	stTimeWait    = "06"
)

// sockEntry is one parsed row of /proc/net/{tcp,tcp6,udp,udp6}.
type sockEntry struct {
	proto string
	local string // hex address
	port  uint16
	state string
	inode string
}

// parseNetProto parses one /proc/net/* file body. Format per row:
// sl local_address rem_address st ... inode at field 9.
func parseNetProto(proto string, data string) []sockEntry {
	var out []sockEntry
	sc := bufio.NewScanner(strings.NewReader(data))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 10 || f[0] == "sl" {
			continue
		}
		la := strings.SplitN(f[1], ":", 2)
		if len(la) != 2 {
			continue
		}
		port64, err := strconv.ParseUint(la[1], 16, 32)
		if err != nil || port64 > 65535 {
			continue
		}
		out = append(out, sockEntry{
			proto: proto,
			local: la[0],
			port:  uint16(port64),
			state: f[3],
			inode: f[9],
		})
	}
	return out
}

func readAllSockets() []sockEntry {
	var out []sockEntry
	for _, spec := range [][2]string{
		{"tcp", procFile("net/tcp")},
		{"tcp6", procFile("net/tcp6")},
		{"udp", procFile("net/udp")},
		{"udp6", procFile("net/udp6")},
	} {
		b, err := os.ReadFile(spec[1])
		if err != nil {
			continue
		}
		out = append(out, parseNetProto(spec[0], string(b))...)
	}
	return out
}

func connectionMetrics(socks []sockEntry) Connections {
	c := Connections{}
	for _, s := range socks {
		c.Total++
		switch {
		case s.proto == "udp" || s.proto == "udp6":
			c.UDP++
		case s.state == stEstablished:
			c.Established++
		case s.state == stListen:
			c.Listen++
		case s.state == stTimeWait:
			c.TimeWait++
		}
	}
	return c
}

// hexToIP renders the little-endian hex addresses in /proc/net/*.
// 8 hex chars is IPv4 (LE u32); 32 chars is IPv6 (4 LE u32 words).
func hexToIP(h string) string {
	if len(h) == 8 {
		var b [4]byte
		for i := 0; i < 4; i++ {
			v, _ := strconv.ParseUint(h[i*2:i*2+2], 16, 8)
			b[3-i] = byte(v)
		}
		return fmt.Sprintf("%d.%d.%d.%d", b[0], b[1], b[2], b[3])
	}
	if len(h) == 32 {
		var words [4]uint32
		for i := 0; i < 4; i++ {
			v, err := strconv.ParseUint(h[i*8:i*8+8], 16, 32)
			if err != nil {
				return h
			}
			// Each 32-bit word is stored little-endian.
			words[i] = uint32(v>>24) | uint32(v>>8)&0xff00 | uint32(v<<8)&0xff0000 | uint32(v<<24)
		}
		return fmt.Sprintf("%x:%x:%x:%x:%x:%x:%x:%x",
			words[0]>>16, words[0]&0xffff, words[1]>>16, words[1]&0xffff,
			words[2]>>16, words[2]&0xffff, words[3]>>16, words[3]&0xffff)
	}
	return h
}

// inodeOwners maps socket inodes to process names by scanning
// /proc/*/fd symlinks. Requires permission to read other processes'
// fds; runs unprivileged fine but yields empty names.
func inodeOwners() map[string]string {
	owners := make(map[string]string)
	procs, err := os.ReadDir(procRoot)
	if err != nil {
		return owners
	}
	for _, p := range procs {
		if !p.IsDir() || p.Name()[0] < '0' || p.Name()[0] > '9' {
			continue
		}
		fds, err := os.ReadDir(procFile(p.Name() + "/fd"))
		if err != nil {
			continue
		}
		var comm string
		for _, fd := range fds {
			link, err := os.Readlink(procFile(p.Name() + "/fd/" + fd.Name()))
			if err != nil || !strings.HasPrefix(link, "socket:[") {
				continue
			}
			inode := strings.TrimSuffix(strings.TrimPrefix(link, "socket:["), "]")
			if comm == "" {
				comm = readTrimMust(procFile(p.Name() + "/comm"))
			}
			owners[inode] = comm
		}
	}
	return owners
}

// portMetrics lists listening sockets. UDP "listening" rows have no
// LISTEN state; treat UDP entries with a zero remote address as bound.
func portMetrics(socks []sockEntry) []Port {
	owners := inodeOwners()
	seen := map[string]bool{}
	var out []Port
	for _, s := range socks {
		isTCP := s.proto == "tcp" || s.proto == "tcp6"
		if isTCP && s.state != stListen {
			continue
		}
		key := s.proto + "/" + strconv.Itoa(int(s.port)) + "/" + s.local
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, Port{
			Proto:   s.proto,
			Port:    s.port,
			Address: hexToIP(s.local),
			Process: owners[s.inode],
		})
	}
	return out
}
