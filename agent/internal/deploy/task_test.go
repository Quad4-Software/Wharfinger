package deploy

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseTaskSpec(t *testing.T) {
	good := `{"action":"service.restart","unit":"nginx"}`
	s, err := ParseTaskSpec(good)
	if err != nil {
		t.Fatal(err)
	}
	if s.Action != "service.restart" || s.Unit != "nginx" {
		t.Fatalf("bad spec: %+v", s)
	}
	if _, err := ParseTaskSpec(`{"action":"packages.apply","securityOnly":true}`); err != nil {
		t.Fatal(err)
	}
	if _, err := ParseTaskSpec(`{"action":"host.reboot"}`); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		`{"action":"service.start"}`,                           // unit required
		`{"action":"service.start","unit":"nginx; rm -rf /"}`,  // injection
		`{"action":"service.start","unit":"../../etc/passwd"}`, // traversal
		`{"action":"service.start","unit":""}`,
		`{"action":"packages.apply","unit":"nginx"}`,    // unit off-action
		`{"action":"service.stop","securityOnly":true}`, // flag off-action
		`{"action":"host.poweroff"}`,                    // unknown action
		`{"action":""}`,
		`{"action":"packages.refresh","unit":"x"}`,
		`not json`,
	} {
		if _, err := ParseTaskSpec(bad); err == nil {
			t.Fatalf("spec %s must fail", bad)
		}
	}
}

func TestServiceArgv(t *testing.T) {
	cases := []struct {
		init, action, unit string
		want               string
	}{
		{"systemd", "service.start", "nginx", "systemctl start nginx.service"},
		{"systemd", "service.stop", "docker.socket", "systemctl stop docker.socket"},
		{"systemd", "service.restart", "ssh", "systemctl restart ssh.service"},
		{"openrc", "service.restart", "nginx", "rc-service nginx restart"},
	}
	for _, c := range cases {
		got := serviceArgv(c.init, c.action, c.unit)
		j := strings.Join(got, " ")
		if !strings.HasSuffix(j, c.want) {
			t.Fatalf("%s %s on %s: got %q want suffix %q", c.action, c.unit, c.init, j, c.want)
		}
	}
}

func TestPkgArgv(t *testing.T) {
	cases := []struct {
		action, manager string
		securityOnly    bool
		want            string
		honored         bool
	}{
		{"packages.refresh", "apt", false, "apt-get update", true},
		{"packages.apply", "apt", true, "apt-get -y", false},
		{"packages.apply", "dnf", true, "dnf -y update --security", true},
		{"packages.apply", "dnf", false, "dnf -y update", true},
		{"packages.apply", "zypper", true, "zypper --non-interactive patch --category security", true},
		{"packages.apply", "pacman", false, "pacman -Syu --noconfirm", true},
		{"packages.refresh", "apk", false, "apk update", true},
		{"packages.apply", "apk", false, "apk upgrade --available", true},
	}
	for _, c := range cases {
		got, honored := pkgArgv(c.action, c.manager, c.securityOnly)
		if got == nil {
			t.Fatalf("%s on %s: nil argv", c.action, c.manager)
		}
		j := strings.Join(got, " ")
		// argv[0] is a resolved path; compare the tail.
		if !strings.Contains(j, c.want) {
			t.Fatalf("%s on %s (sec=%v): got %q want %q", c.action, c.manager, c.securityOnly, j, c.want)
		}
		if honored != c.honored {
			t.Fatalf("%s on %s: honored=%v want %v", c.action, c.manager, honored, c.honored)
		}
	}
	if got, _ := pkgArgv("packages.apply", "zypperx", false); got != nil {
		t.Fatalf("unknown manager must return nil, got %v", got)
	}
}

// stubDetect overrides the host probes for a test.
func stubDetect(init, pkg string, argv []string) func() {
	oldInit, oldPkg, oldArgv := detectInit, detectPkgManager, rebootArgv
	oldPre, oldDelay := rebootPreflight, rebootDelay
	detectInit = func() string { return init }
	detectPkgManager = func() string { return pkg }
	rebootArgv = func() []string { return argv }
	rebootPreflight = func() error { return nil }
	rebootDelay = 0
	return func() {
		detectInit, detectPkgManager = oldInit, oldPkg
		rebootArgv, rebootPreflight, rebootDelay = oldArgv, oldPre, oldDelay
	}
}

func TestExecuteTaskService(t *testing.T) {
	undo := stubDetect("systemd", "", nil)
	defer undo()

	runner := &fakeRunner{failAt: -1}
	rt := &Runtime{Name: "podman", Bin: "/bin/podman", runner: runner}
	hub := &actionHub{t: t}
	srv := httptest.NewServer(hub.handler())
	defer srv.Close()
	e := testExecutor(t, srv.URL, rt)

	job := &Job{ID: 11, Kind: "agent-task", Lease: "l1",
		Spec: `{"action":"service.restart","unit":"nginx"}`}
	if err := e.Execute(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	j := joined(runner.argv)
	if !strings.Contains(j, "systemctl restart nginx.service") {
		t.Fatalf("missing restart argv:\n%s", j)
	}
	if hub.actions[len(hub.actions)-1] != "succeed" {
		t.Fatalf("actions: %v", hub.actions)
	}
	res, _ := hub.last["result"].(map[string]any)
	if res["action"] != "service.restart" || res["unit"] != "nginx" {
		t.Fatalf("result: %v", res)
	}
}

func TestExecuteTaskServiceFails(t *testing.T) {
	undo := stubDetect("systemd", "", nil)
	defer undo()

	runner := &fakeRunner{failAt: 0}
	rt := &Runtime{Name: "podman", Bin: "/bin/podman", runner: runner}
	hub := &actionHub{t: t}
	srv := httptest.NewServer(hub.handler())
	defer srv.Close()
	e := testExecutor(t, srv.URL, rt)

	job := &Job{ID: 12, Kind: "agent-task", Lease: "l2",
		Spec: `{"action":"service.stop","unit":"ssh"}`}
	if err := e.Execute(context.Background(), job); err == nil {
		t.Fatal("a failed verb must return the cause")
	}
	if hub.actions[len(hub.actions)-1] != "fail" {
		t.Fatalf("actions: %v", hub.actions)
	}
}

func TestExecuteTaskPackages(t *testing.T) {
	undo := stubDetect("", "dnf", nil)
	defer undo()

	runner := &fakeRunner{failAt: -1}
	rt := &Runtime{Name: "podman", Bin: "/bin/podman", runner: runner}
	hub := &actionHub{t: t}
	srv := httptest.NewServer(hub.handler())
	defer srv.Close()
	e := testExecutor(t, srv.URL, rt)

	job := &Job{ID: 13, Kind: "agent-task", Lease: "l3",
		Spec: `{"action":"packages.apply","securityOnly":true}`}
	if err := e.Execute(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	j := joined(runner.argv)
	if !strings.Contains(j, "dnf -y update --security") {
		t.Fatalf("missing apply argv:\n%s", j)
	}
	if hub.actions[len(hub.actions)-1] != "succeed" {
		t.Fatalf("actions: %v", hub.actions)
	}
}

func TestExecuteTaskReboot(t *testing.T) {
	undo := stubDetect("", "", []string{"/bin/systemctl", "reboot"})
	defer undo()

	runner := &fakeRunner{failAt: -1}
	rt := &Runtime{Name: "podman", Bin: "/bin/podman", runner: runner}
	hub := &actionHub{t: t}
	srv := httptest.NewServer(hub.handler())
	defer srv.Close()
	e := testExecutor(t, srv.URL, rt)

	job := &Job{ID: 14, Kind: "agent-task", Lease: "l4",
		Spec: `{"action":"host.reboot"}`}
	start := time.Now()
	if err := e.Execute(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	// The job closes before the reboot argv runs.
	if !strings.Contains(joined(runner.argv), "systemctl reboot") {
		t.Fatalf("missing reboot argv:\n%s", joined(runner.argv))
	}
	succeedIdx := -1
	for i, a := range hub.actions {
		if a == "succeed" {
			succeedIdx = i
		}
	}
	if succeedIdx < 0 {
		t.Fatalf("no succeed action: %v", hub.actions)
	}
	_ = start
}

func TestExecuteTaskBadSpec(t *testing.T) {
	runner := &fakeRunner{failAt: -1}
	rt := &Runtime{Name: "podman", Bin: "/bin/podman", runner: runner}
	hub := &actionHub{t: t}
	srv := httptest.NewServer(hub.handler())
	defer srv.Close()
	e := testExecutor(t, srv.URL, rt)

	job := &Job{ID: 15, Kind: "agent-task", Lease: "l5",
		Spec: `{"action":"service.start","unit":"a; b"}`}
	if err := e.Execute(context.Background(), job); err == nil {
		t.Fatal("a bad spec must return the cause")
	}
	if len(runner.argv) != 0 {
		t.Fatalf("no command must run on a bad spec: %s", joined(runner.argv))
	}
	if hub.actions[len(hub.actions)-1] != "fail" {
		t.Fatalf("actions: %v", hub.actions)
	}
}
