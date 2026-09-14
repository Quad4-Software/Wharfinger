package collect

import (
	"testing"
)

func TestParseReticulumConfig(t *testing.T) {
	cfg := parseReticulumConfig(`
# comment
[reticulum]
enable_transport = yes
enable_control_api = yes
control_api_host = 127.0.0.1
control_api_port = 37430
rpc_key = aabbcc

[logging]
loglevel = 4

[interfaces]
[[Backbone]]
type = BackboneInterface
[[Local]]
type = LocalInterface
`)
	if !cfg.controlAPI || cfg.apiPort != 37430 || cfg.rpcKey != "aabbcc" || cfg.ifaceCount != 2 {
		t.Fatalf("bad config parse: %+v", cfg)
	}

	off := parseReticulumConfig("[reticulum]\nenable_control_api = no\n")
	if off.controlAPI {
		t.Fatal("control api should be off")
	}
}

func TestParseReticulumStatus(t *testing.T) {
	out := `TCPInterface[RNS Testnet Frankfurt/frankfurt.rns.unsigned.io:4965]
   Status  : Up
   Mode    : Full
   Rate    : 10.00 Mbps
   Clients : 0
   Traffic : 187.27 KB↑
             74.17 KB↓
AutoInterface[Local Peers]
   Status  : Up
   Mode    : Full
   Peers   : 3 reachable
   Traffic : 1.02 MB↑
             512.00 B↓

Reticulum Transport Instance <5245a8efe1788c6a70e1> running
`
	r := &Reticulum{}
	parseReticulumStatus(out, r)
	if r.Identity != "5245a8efe1788c6a70e1" {
		t.Fatalf("identity = %q", r.Identity)
	}
	if len(r.Interfaces) != 2 {
		t.Fatalf("interfaces = %d", len(r.Interfaces))
	}
	a := r.Interfaces[0]
	if a.Type != "TCPInterface" || a.Name != "RNS Testnet Frankfurt/frankfurt.rns.unsigned.io:4965" {
		t.Fatalf("iface0 = %+v", a)
	}
	if a.Status != "up" || a.Mode != "Full" {
		t.Fatalf("iface0 status/mode = %+v", a)
	}
	if a.TxBytes != 187270 || a.RxBytes != 74170 {
		t.Fatalf("iface0 traffic tx=%d rx=%d", a.TxBytes, a.RxBytes)
	}
	b := r.Interfaces[1]
	if b.Type != "AutoInterface" || b.Clients != 3 {
		t.Fatalf("iface1 = %+v", b)
	}
	if b.TxBytes != 1020000 || b.RxBytes != 512 {
		t.Fatalf("iface1 traffic tx=%d rx=%d", b.TxBytes, b.RxBytes)
	}
}

func TestParseRnsBytes(t *testing.T) {
	for s, want := range map[string]uint64{
		"187.27 KB":   187270,
		"512.00 B":    512,
		"1.5 MB":      1500000,
		"2 GiB":       2 * 1024 * 1024 * 1024,
		"garbage":     0,
		"10":          0,
		"":            0,
		"3 KB↓ extra": 3000,
	} {
		if got := parseRnsBytes(s); got != want {
			t.Errorf("parseRnsBytes(%q) = %d, want %d", s, got, want)
		}
	}
}

func TestParseRnsFindings(t *testing.T) {
	f := parseRnsFindings("\nNo findings reported\n\n", 8)
	if len(f) != 0 {
		t.Fatalf("expected no findings, got %v", f)
	}
	many := ""
	for i := 0; i < 20; i++ {
		many += "finding line\n"
	}
	if got := parseRnsFindings(many, 8); len(got) != 8 {
		t.Fatalf("cap not applied: %d", len(got))
	}
}
