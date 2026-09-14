package collect

import (
	"reflect"
	"testing"
)

const listAllZonesSample = `public
  target: default
  icmp-block-inversion: no
  interfaces: eth0
  sources:
  services: cockpit dhcpv6-client ssh
  ports: 8080/tcp 53/udp
  protocols:
  forward: yes
  masquerade: no
  forward-ports:
  source-ports:
  icmp-blocks:
  rich rules:
	rule family="ipv4" source address="10.0.0.0/24" accept

dmz
  target: default
  icmp-block-inversion: no
  interfaces:
  sources:
  services: http
  ports: 9090/tcp
  protocols:
  forward: yes
  masquerade: no
  forward-ports:
  source-ports:
  icmp-blocks:
  rich rules:

block (active)
  target: %%REJECT%%
  icmp-block-inversion: no
  interfaces:
  sources:
  services:
  ports: 53/udp
  protocols:
  forward: yes
  masquerade: no
  forward-ports:
  source-ports:
  icmp-blocks:
  rich rules:
`

func TestParseFirewalldZones(t *testing.T) {
	zones, ports, rich := parseFirewalldZones(listAllZonesSample)
	if !reflect.DeepEqual(zones, []string{"public", "dmz", "block"}) {
		t.Fatalf("zones: %v", zones)
	}
	// 53/udp appears in two zones and must dedupe; sorted output.
	want := []string{"53/udp", "8080/tcp", "9090/tcp"}
	if !reflect.DeepEqual(ports, want) {
		t.Fatalf("ports: %v", ports)
	}
	if rich != 1 {
		t.Fatalf("rich rules: %d", rich)
	}
}

func TestParseFirewalldZonesEmpty(t *testing.T) {
	zones, ports, rich := parseFirewalldZones("")
	if len(zones) != 0 || len(ports) != 0 || rich != 0 {
		t.Fatalf("empty input: %v %v %d", zones, ports, rich)
	}
}

func TestFirewalldBypassed(t *testing.T) {
	open := []string{"22/tcp", "8080/tcp"}
	published := []string{"8080/tcp", "3000/tcp", "53/udp"}
	got := firewalldBypassed(published, open)
	want := []string{"3000/tcp", "53/udp"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("bypassed: %v want %v", got, want)
	}
	if got := firewalldBypassed(nil, open); len(got) != 0 {
		t.Fatalf("no published ports must flag nothing: %v", got)
	}
}

func TestFirewalldBypassedRanges(t *testing.T) {
	// A published port inside an opened range is covered, not
	// bypassed; outside the range or on a different proto it is.
	open := []string{"8000-8100/tcp", "53/udp"}
	published := []string{"8080/tcp", "53/udp", "8200/tcp", "8080/udp"}
	got := firewalldBypassed(published, open)
	want := []string{"8200/tcp", "8080/udp"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("bypassed: %v want %v", got, want)
	}
}
