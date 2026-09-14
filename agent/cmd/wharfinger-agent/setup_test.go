package main

import (
	"strings"
	"testing"
)

func TestParseOSRelease(t *testing.T) {
	osr := parseOSRelease(`NAME="Fedora Linux"
VERSION="40 (Forty)"
ID=fedora
ID_LIKE="rhel fedora"
# comment line
BARE=
`)
	if osr["ID"] != "fedora" || osr["ID_LIKE"] != "rhel fedora" {
		t.Fatalf("parse: %v", osr)
	}
	if v, ok := osr["BARE"]; !ok || v != "" {
		t.Fatalf("bare empty value: %q", v)
	}
}

func TestDistroFamily(t *testing.T) {
	cases := []struct {
		osr  map[string]string
		want string
	}{
		{map[string]string{"ID": "debian"}, "debian"},
		{map[string]string{"ID": "ubuntu", "ID_LIKE": "debian"}, "debian"},
		{map[string]string{"ID": "fedora"}, "fedora"},
		{map[string]string{"ID": "centos", "ID_LIKE": "rhel fedora"}, "fedora"},
		{map[string]string{"ID": "rocky", "ID_LIKE": "rhel centos fedora"}, "fedora"},
		{map[string]string{"ID": "alpine"}, "alpine"},
		{map[string]string{"ID": "arch"}, "arch"},
		{map[string]string{"ID": "manjaro", "ID_LIKE": "arch"}, "arch"},
		{map[string]string{"ID": "opensuse"}, ""},
		{map[string]string{}, ""},
	}
	for i, c := range cases {
		if got := distroFamily(c.osr); got != c.want {
			t.Fatalf("case %d: got %q want %q", i, got, c.want)
		}
	}
}

// stepArgv flattens a plan into its runnable argv steps for
// assertions.
func stepArgv(steps []setupStep) [][]string {
	var out [][]string
	for _, st := range steps {
		if st.argv != nil {
			out = append(out, st.argv)
		}
	}
	return out
}

func argvText(steps []setupStep) string {
	var b strings.Builder
	for _, a := range stepArgv(steps) {
		b.WriteString(strings.Join(a, " "))
		b.WriteByte('\n')
	}
	return b.String()
}

func TestBuildPlanDebian(t *testing.T) {
	steps := buildPlan(setupFacts{family: "debian"})
	text := argvText(steps)
	if !strings.Contains(text, "apt-get install -y podman") {
		t.Fatalf("debian plan must install podman:\n%s", text)
	}
	if strings.Contains(text, "kubectl") && !strings.Contains(text, "kubernetes") {
		// debian has no native kubectl package; the step must be a
		// note, never an argv.
		t.Fatalf("debian must not install kubectl via package manager:\n%s", text)
	}
	for _, st := range steps {
		if st.argv != nil && st.argv[0] == "apt-get" && strings.Contains(strings.Join(st.argv, " "), "trivy") {
			t.Fatal("debian must not install trivy via apt (no native package)")
		}
	}
	if !strings.Contains(text, "useradd --system") {
		t.Fatalf("missing useradd step:\n%s", text)
	}
	found := false
	for _, st := range steps {
		if st.file != nil && st.file.path == sudoersPath {
			found = true
			if st.file.perm != 0o440 {
				t.Fatalf("sudoers mode: %o", st.file.perm)
			}
		}
	}
	if !found {
		t.Fatal("no sudoers file step")
	}
}

func TestBuildPlanAlpine(t *testing.T) {
	steps := buildPlan(setupFacts{family: "alpine"})
	text := argvText(steps)
	if !strings.Contains(text, "apk add podman") {
		t.Fatalf("alpine runtime install:\n%s", text)
	}
	if !strings.Contains(text, "apk add kubectl") || !strings.Contains(text, "apk add trivy") {
		t.Fatalf("alpine native tool packages missing:\n%s", text)
	}
	if !strings.Contains(text, "adduser -S") {
		t.Fatalf("alpine user creation must use adduser:\n%s", text)
	}
}

func TestBuildPlanDockerGroupAfterUser(t *testing.T) {
	steps := buildPlan(setupFacts{family: "fedora", useDocker: true})
	var userIdx, groupIdx int = -1, -1
	for i, st := range steps {
		if st.argv == nil {
			continue
		}
		if st.argv[0] == "useradd" {
			userIdx = i
		}
		if st.argv[0] == "usermod" {
			groupIdx = i
		}
	}
	if userIdx < 0 || groupIdx < 0 {
		t.Fatalf("expected useradd and usermod steps:\n%s", argvText(steps))
	}
	if groupIdx < userIdx {
		t.Fatal("usermod must run after the user exists")
	}
	text := argvText(steps)
	if !strings.Contains(text, "moby-engine") {
		t.Fatalf("fedora docker package:\n%s", text)
	}
}

func TestBuildPlanExistingTools(t *testing.T) {
	steps := buildPlan(setupFacts{
		family: "arch", hasPodman: true, hasKubectl: true, hasTrivy: true,
		hasUser: true, hasVisudo: true,
	})
	text := argvText(steps)
	if strings.Contains(text, "pacman -S") {
		t.Fatalf("installed tools must not be reinstalled:\n%s", text)
	}
	if !strings.Contains(text, "visudo -cf "+sudoersPath) {
		t.Fatalf("visudo validation step missing:\n%s", text)
	}
}

func TestBuildPlanK3sNote(t *testing.T) {
	steps := buildPlan(setupFacts{family: "arch", hasK3s: true})
	for _, st := range steps {
		if st.argv != nil && strings.Contains(strings.Join(st.argv, " "), "kubectl") {
			t.Fatal("k3s hosts must not install standalone kubectl")
		}
	}
	found := false
	for _, st := range steps {
		if strings.Contains(st.note, "k3s kubectl") {
			found = true
		}
	}
	if !found {
		t.Fatal("k3s hosts must get the k3s kubectl note")
	}
}

func TestSudoersDropInShape(t *testing.T) {
	s := sudoersDropIn("wharfinger-agent")
	if strings.Contains(s, "NOPASSWD: ALL") {
		t.Fatal("sudoers must never grant ALL")
	}
	if strings.ContainsAny(s, "*") {
		// A literal asterisk would be a wildcard grant.
		t.Fatal("sudoers must not contain wildcards")
	}
	for _, verb := range []string{
		"/ufw status",
		"/firewall-cmd --list-all-zones",
		"/firewall-cmd --state",
		"systemctl restart wharfinger-agent",
		"systemctl is-active wharfinger-agent",
	} {
		if !strings.Contains(s, verb) {
			t.Fatalf("missing verb %q in:\n%s", verb, s)
		}
	}
	// Every grant line names the agent user and an absolute path.
	for _, line := range strings.Split(s, "\n") {
		if !strings.Contains(line, "NOPASSWD:") {
			continue
		}
		if !strings.HasPrefix(line, "wharfinger-agent ALL=(root) NOPASSWD: /") {
			t.Fatalf("grant line not scoped to an absolute path: %q", line)
		}
	}
}
