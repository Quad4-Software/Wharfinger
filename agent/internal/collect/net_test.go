package collect

import (
	"net"
	"testing"
)

func cidr(t *testing.T, s string) *net.IPNet {
	t.Helper()
	ip, n, err := net.ParseCIDR(s)
	if err != nil {
		t.Fatalf("bad cidr %s: %v", s, err)
	}
	n.IP = ip // host address, like net.Interface.Addrs() reports
	return n
}

func TestCollectIfaceAddrs(t *testing.T) {
	list := []ifAddrs{
		{
			name: "eth0",
			addrs: []net.Addr{
				cidr(t, "203.0.113.10/24"),
				cidr(t, "2001:db8::10/64"),
				cidr(t, "169.254.1.5/16"), // link-local: dropped
				cidr(t, "fe80::abcd/64"),  // v6 link-local: dropped
				cidr(t, "10.0.0.5/8"),     // private: kept, hub classifies
			},
		},
		{name: "lo", addrs: []net.Addr{cidr(t, "127.0.0.1/8")}},
		{name: "docker0", addrs: []net.Addr{cidr(t, "172.17.0.1/16")}},
		{name: "veth42", addrs: []net.Addr{cidr(t, "172.18.0.9/16")}},
	}
	got := collectIfaceAddrs(list)
	want := []string{"10.0.0.5", "2001:db8::10", "203.0.113.10"}
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
}

func TestCollectIfaceAddrsCap(t *testing.T) {
	var list []ifAddrs
	for i := 0; i < 100; i++ {
		_, n, _ := net.ParseCIDR("198.51.100.1/24")
		n.IP = net.IPv4(198, 51, byte(i/256), byte(i%256))
		list = append(list, ifAddrs{name: "eth0", addrs: []net.Addr{n}})
	}
	got := collectIfaceAddrs(list)
	if len(got) != 64 {
		t.Fatalf("expected cap of 64, got %d", len(got))
	}
}
