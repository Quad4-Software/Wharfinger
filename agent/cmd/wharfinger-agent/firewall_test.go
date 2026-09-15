package main

import (
	"strings"
	"testing"
)

func TestFwFixRules(t *testing.T) {
	rules := fwFixRules(true)
	// 3 early returns + ufw jump + 3 tcp drops + 3 udp drops.
	if len(rules) != 10 {
		t.Fatalf("expected 10 rules, got %d", len(rules))
	}
	for i, cidr := range fwFixNets {
		if rules[i].pos != i+1 || !strings.Contains(strings.Join(rules[i].spec, " "), "-s "+cidr+" -m comment --comment "+fwFixTag+" -j RETURN") {
			t.Fatalf("rule %d malformed: %+v", i, rules[i])
		}
	}
	if rules[3].pos != 4 || rules[3].spec[len(rules[3].spec)-1] != "ufw-user-forward" {
		t.Fatalf("ufw jump missing: %+v", rules[3])
	}
	for _, r := range rules[4:] {
		if r.pos != 0 {
			t.Fatalf("drop rules must append, got pos %d", r.pos)
		}
		if r.spec[len(r.spec)-1] != "DROP" {
			t.Fatalf("expected DROP tail: %v", r.spec)
		}
		// comment match must sit before the jump, not after it
		j := strings.Join(r.spec, " ")
		if strings.Index(j, "--comment "+fwFixTag) > strings.Index(j, "-j DROP") {
			t.Fatalf("comment after jump: %s", j)
		}
	}
}

func TestFwFixRulesNoUfw(t *testing.T) {
	rules := fwFixRules(false)
	if len(rules) != 9 {
		t.Fatalf("expected 9 rules without ufw, got %d", len(rules))
	}
	for _, r := range rules {
		for _, f := range r.spec {
			if f == "ufw-user-forward" {
				t.Fatal("ufw jump present without ufw")
			}
		}
	}
}

func TestFwRevertSpecs(t *testing.T) {
	save := `-P DOCKER-USER RETURN
-A DOCKER-USER -s 10.0.0.0/8 -m comment --comment wharfinger-fwfix -j RETURN
-A DOCKER-USER -i eth0 -p tcp -m tcp --dport 80 -j ACCEPT
-A DOCKER-USER -m comment --comment "wharfinger-fwfix" -j ufw-user-forward
-A DOCKER-USER -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN -d 10.0.0.0/8 -m comment --comment wharfinger-fwfix -j DROP
`
	specs := fwRevertSpecs(save)
	if len(specs) != 3 {
		t.Fatalf("expected 3 revert specs, got %v", specs)
	}
	for _, s := range specs {
		if len(s) < 2 || s[0] == "-A" {
			t.Fatalf("spec must drop the -A DOCKER-USER prefix: %v", s)
		}
	}
	if got := strings.Join(specs[1], " "); !strings.Contains(got, "ufw-user-forward") {
		t.Fatalf("jump rule not captured: %v", specs[1])
	}
}
