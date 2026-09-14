package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"strings"
)

// wharfinger-agent setup provisions a host for the agent: container
// runtime, kubectl, trivy, the service user, its state dir, and a
// scoped sudoers drop-in. It is a plan-then-execute tool: without
// -yes nothing runs. Package installs use the distro's native
// manager with fixed argv; trivy on debian and kubectl on debian are
// printed as manual instructions because they live in third-party
// repos, and no install script is ever piped to a shell.

const (
	agentUser    = "wharfinger-agent"
	agentHome    = "/var/lib/wharfinger-agent"
	agentState   = agentHome + "/.config/wharfinger-agent"
	sudoersPath  = "/etc/sudoers.d/" + agentUser
	osReleaseSrc = "/etc/os-release"
)

// setupStep is one planned action. Exactly one of argv, file, or
// note is set: argv steps run a fixed command, file steps write a
// file, notes only print guidance.
type setupStep struct {
	desc string
	argv []string
	file *setupFile
	note string
}

type setupFile struct {
	path string
	data string
	perm os.FileMode
}

// setupFacts is the host state the plan is built from. Keeping
// detection separate makes plan generation a pure function.
type setupFacts struct {
	family     string // debian | fedora | alpine | arch
	useDocker  bool
	hasPodman  bool
	hasDocker  bool
	hasKubectl bool
	hasK3s     bool
	hasTrivy   bool
	hasUser    bool
	hasVisudo  bool
}

// parseOSRelease reads KEY=VALUE lines from /etc/os-release; values
// may be quoted.
func parseOSRelease(data string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(data, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		out[k] = strings.Trim(strings.TrimSpace(v), `"'`)
	}
	return out
}

// distroFamily maps os-release ID/ID_LIKE tokens onto a package
// manager family. Unknown or absent ids yield "" and the caller
// prints a manual checklist.
func distroFamily(osr map[string]string) string {
	tokens := strings.Fields(osr["ID"] + " " + osr["ID_LIKE"])
	families := []struct {
		name  string
		match []string
	}{
		{"debian", []string{"debian", "ubuntu"}},
		{"fedora", []string{"fedora", "rhel", "centos"}},
		{"alpine", []string{"alpine"}},
		{"arch", []string{"arch"}},
	}
	for _, f := range families {
		for _, m := range f.match {
			for _, tok := range tokens {
				if tok == m {
					return f.name
				}
			}
		}
	}
	return ""
}

// pkgInstall returns the package-manager argv for the family.
func pkgInstall(family string, pkgs ...string) [][]string {
	switch family {
	case "debian":
		return [][]string{
			{"apt-get", "update"},
			append([]string{"apt-get", "install", "-y"}, pkgs...),
		}
	case "fedora":
		return [][]string{append([]string{"dnf", "install", "-y"}, pkgs...)}
	case "alpine":
		return [][]string{append([]string{"apk", "add"}, pkgs...)}
	case "arch":
		return [][]string{append([]string{"pacman", "-S", "--noconfirm", "--needed"}, pkgs...)}
	}
	return nil
}

// toolPkgs names the package that provides a tool per family, or ""
// when no native package exists and manual install is required.
func toolPkgs(family, tool string) []string {
	switch tool {
	case "podman":
		return []string{"podman"}
	case "docker":
		switch family {
		case "debian":
			return []string{"docker.io"}
		case "fedora":
			return []string{"moby-engine"}
		default:
			return []string{"docker"}
		}
	case "kubectl":
		switch family {
		case "fedora":
			return []string{"kubernetes-client"}
		case "alpine", "arch":
			return []string{"kubectl"}
		}
	case "trivy":
		switch family {
		case "fedora", "alpine", "arch":
			return []string{"trivy"}
		}
	}
	return nil
}

// nologinShell is the nologin path each family ships.
func nologinShell(family string) string {
	switch family {
	case "arch":
		return "/usr/bin/nologin"
	case "alpine":
		return "/sbin/nologin"
	default:
		return "/usr/sbin/nologin"
	}
}

// userAddArgv creates the wharfinger-agent service user per family.
func userAddArgv(family string) []string {
	if family == "alpine" {
		return []string{"adduser", "-S", "-D", "-h", agentHome, "-s", nologinShell(family), agentUser}
	}
	// --user-group creates the matching wharfinger-agent group; without
	// it distros like arch default the user to group 100 and the
	// state-dir chown would have no group to name.
	return []string{"useradd", "--system", "--user-group", "--create-home",
		"--home-dir", agentHome, "--shell", nologinShell(family), agentUser}
}

// dockerGroupArgv adds the service user to the docker group; only
// needed when docker is the chosen runtime since rootless podman
// needs no group.
func dockerGroupArgv(family string) []string {
	if family == "alpine" {
		return []string{"addgroup", agentUser, "docker"}
	}
	return []string{"usermod", "-aG", "docker", agentUser}
}

// sudoersDropIn scopes the service user's sudo to exactly the verbs
// the agent needs and nothing else:
//   - ufw status: the firewall collector shells out to ufw and
//     non-root reads are denied on most distros.
//   - firewall-cmd read-only queries: same reason on firewalld
//     distros where polkit blocks unprivileged listing.
//   - systemctl restart/status/is-active wharfinger-agent: lets the
//     service user bounce its own unit (self-update restart path)
//     without general systemctl access.
//
// Both /usr/bin and /usr/sbin spellings appear because distros
// disagree on where these tools live. No wildcards anywhere.
func sudoersDropIn(user string) string {
	var b strings.Builder
	b.WriteString("# " + user + " service account privileges, installed by wharfinger-agent setup.\n")
	b.WriteString("# Each line is one exact verb; no wildcards, no broad grants.\n")
	b.WriteString("# Firewall state queries the collectors need (read-only).\n")
	for _, dir := range []string{"/usr/sbin", "/usr/bin"} {
		fmt.Fprintf(&b, "%s ALL=(root) NOPASSWD: %s/ufw status\n", user, dir)
	}
	for _, dir := range []string{"/usr/sbin", "/usr/bin"} {
		for _, verb := range []string{
			"--state", "--get-zones", "--get-default-zone", "--list-all", "--list-all-zones",
		} {
			fmt.Fprintf(&b, "%s ALL=(root) NOPASSWD: %s/firewall-cmd %s\n", user, dir, verb)
		}
	}
	b.WriteString("# Own-unit lifecycle only; no other systemctl access.\n")
	for _, verb := range []string{"restart", "status", "is-active"} {
		fmt.Fprintf(&b, "%s ALL=(root) NOPASSWD: /usr/bin/systemctl %s %s\n", user, verb, user)
	}
	return b.String()
}

// buildPlan turns detected host facts into ordered steps. Runtime
// choice: podman unless -docker was passed or docker is already the
// only runtime present.
func buildPlan(f setupFacts) []setupStep {
	var steps []setupStep

	dockerChosen := f.useDocker || (!f.hasPodman && f.hasDocker)
	switch {
	case f.hasPodman && !f.useDocker:
		steps = append(steps, setupStep{desc: "container runtime: podman already installed", note: "nothing to do"})
	case dockerChosen && f.hasDocker:
		steps = append(steps, setupStep{desc: "container runtime: docker already installed", note: "nothing to do"})
	case dockerChosen:
		for _, argv := range pkgInstall(f.family, toolPkgs(f.family, "docker")...) {
			steps = append(steps, setupStep{desc: "install docker (" + strings.Join(argv, " ") + ")", argv: argv})
		}
	default:
		for _, argv := range pkgInstall(f.family, toolPkgs(f.family, "podman")...) {
			steps = append(steps, setupStep{desc: "install podman (" + strings.Join(argv, " ") + ")", argv: argv})
		}
	}

	switch {
	case f.hasKubectl:
		steps = append(steps, setupStep{desc: "kubectl already installed", note: "nothing to do"})
	case f.hasK3s:
		steps = append(steps, setupStep{
			desc: "kubectl via k3s",
			note: "k3s detected: it ships kubectl as 'k3s kubectl'; the agent detects this automatically",
		})
	default:
		if pkgs := toolPkgs(f.family, "kubectl"); pkgs != nil {
			for _, argv := range pkgInstall(f.family, pkgs...) {
				steps = append(steps, setupStep{desc: "install kubectl (" + strings.Join(argv, " ") + ")", argv: argv})
			}
		} else {
			steps = append(steps, setupStep{
				desc: "install kubectl (manual)",
				note: "no native " + f.family + " package; install kubectl from\n" +
					"  https://kubernetes.io/docs/tasks/tools/ or run k3s, which embeds it",
			})
		}
	}

	switch {
	case f.hasTrivy:
		steps = append(steps, setupStep{desc: "trivy already installed", note: "nothing to do"})
	case toolPkgs(f.family, "trivy") != nil:
		for _, argv := range pkgInstall(f.family, toolPkgs(f.family, "trivy")...) {
			steps = append(steps, setupStep{desc: "install trivy (" + strings.Join(argv, " ") + ")", argv: argv})
		}
	default:
		steps = append(steps, setupStep{
			desc: "install trivy (manual)",
			note: "no native " + f.family + " package; see\n" +
				"  https://trivy.dev/latest/getting-started/installation/ (download a release\n" +
				"  archive or use the Aqua repo; do not pipe the install script to a shell)",
		})
	}

	if f.hasUser {
		steps = append(steps, setupStep{desc: "service user " + agentUser + " exists", note: "nothing to do"})
	} else {
		steps = append(steps, setupStep{
			desc: "create service user " + agentUser,
			argv: userAddArgv(f.family),
		})
	}
	// Group membership comes after the user exists; rootless podman
	// needs no group so this only applies to the docker path.
	if dockerChosen {
		steps = append(steps, setupStep{
			desc: "add " + agentUser + " to the docker group",
			argv: dockerGroupArgv(f.family),
		})
	}

	steps = append(steps,
		setupStep{
			desc: "create state dir " + agentState,
			argv: []string{"install", "-d", "-o", agentUser, "-g", agentUser, "-m", "0700", agentState},
		},
		setupStep{
			desc: "own the agent home " + agentHome,
			argv: []string{"chown", agentUser + ":" + agentUser, agentHome},
		},
		setupStep{
			desc: "write scoped sudoers drop-in " + sudoersPath,
			file: &setupFile{path: sudoersPath, data: sudoersDropIn(agentUser), perm: 0o440},
		})
	if f.hasVisudo {
		steps = append(steps, setupStep{
			desc: "validate sudoers syntax",
			argv: []string{"visudo", "-cf", sudoersPath},
		})
	}
	return steps
}

func printPlan(f setupFacts, steps []setupStep) {
	rt := "podman"
	if f.useDocker || (!f.hasPodman && f.hasDocker) {
		rt = "docker"
	}
	fmt.Printf("wharfinger-agent setup plan (distro family: %s, runtime: %s)\n\n", f.family, rt)
	for i, st := range steps {
		fmt.Printf("%2d. %s\n", i+1, st.desc)
		if st.argv != nil {
			fmt.Printf("    $ %s\n", strings.Join(st.argv, " "))
		}
		if st.file != nil {
			fmt.Printf("    write %s (mode %04o)\n", st.file.path, st.file.perm)
		}
		if st.note != "" {
			fmt.Printf("    %s\n", st.note)
		}
	}
}

// printManualChecklist is the fallback for distros the tool does not
// know; it lists what a working install needs without guessing.
func printManualChecklist() {
	fmt.Print(`manual install checklist:
  - container runtime: install podman (preferred) or docker
  - kubectl for k8s deploys: install kubectl, or run k3s which
    embeds it as 'k3s kubectl'
  - trivy for image scanning: see https://trivy.dev/latest/getting-started/installation/
  - create the service user: ` + agentUser + ` (system user, nologin shell)
  - state dir: ` + agentState + ` owned by ` + agentUser + `
  - sudoers: drop-in at ` + sudoersPath + ` scoped to ufw status,
    read-only firewall-cmd queries, and systemctl restart/status of
    the wharfinger-agent unit only
`)
}

func detectFacts(family string, useDocker bool) setupFacts {
	f := setupFacts{family: family, useDocker: useDocker}
	f.hasPodman = haveBin("podman")
	f.hasDocker = haveBin("docker")
	f.hasKubectl = haveBin("kubectl")
	f.hasK3s = haveBin("k3s")
	f.hasTrivy = haveBin("trivy")
	f.hasVisudo = haveBin("visudo")
	_, err := user.Lookup(agentUser)
	f.hasUser = err == nil
	return f
}

func haveBin(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// runStep executes one plan step. Everything is echoed before it
// runs; nothing in setup is silent.
func runStep(st setupStep) error {
	if st.argv != nil {
		fmt.Printf("$ %s\n", strings.Join(st.argv, " "))
		c := exec.Command(st.argv[0], st.argv[1:]...)
		c.Stdout = os.Stdout
		c.Stderr = os.Stderr
		if err := c.Run(); err != nil {
			return fmt.Errorf("%s: %w", st.argv[0], err)
		}
		return nil
	}
	if st.file != nil {
		fmt.Printf("write %s (mode %04o)\n", st.file.path, st.file.perm)
		return os.WriteFile(st.file.path, []byte(st.file.data), st.file.perm)
	}
	return nil
}

// runSetup implements the setup subcommand. Default is a dry-run
// plan print; -yes executes it step by step and stops on the first
// failure so a half-finished install is visible.
func runSetup(args []string) {
	fs := flag.NewFlagSet("wharfinger-agent setup", flag.ContinueOnError)
	yes := fs.Bool("yes", false, "execute the printed plan (default is a dry-run)")
	useDocker := fs.Bool("docker", false, "install docker instead of podman")
	if err := fs.Parse(args); err != nil {
		os.Exit(2)
	}

	osr, err := os.ReadFile(osReleaseSrc)
	if err != nil {
		fmt.Fprintf(os.Stderr, "wharfinger-agent setup: read %s: %v\n", osReleaseSrc, err)
	}
	fam := distroFamily(parseOSRelease(string(osr)))
	if fam == "" {
		fmt.Fprintln(os.Stderr, "wharfinger-agent setup: unsupported distro (no debian, fedora, alpine, or arch in "+osReleaseSrc+")")
		printManualChecklist()
		os.Exit(1)
	}

	f := detectFacts(fam, *useDocker)
	steps := buildPlan(f)
	printPlan(f, steps)

	if !*yes {
		fmt.Println("\ndry-run: re-run with -yes to execute this plan")
		return
	}
	if os.Geteuid() != 0 {
		fmt.Fprintln(os.Stderr, "wharfinger-agent setup: -yes must run as root")
		os.Exit(1)
	}
	fmt.Println()
	for i, st := range steps {
		fmt.Printf("[%d/%d] %s\n", i+1, len(steps), st.desc)
		if err := runStep(st); err != nil {
			if st.argv != nil && st.argv[0] == "visudo" {
				// Never leave a sudoers file visudo rejected.
				_ = os.Remove(sudoersPath)
			}
			fmt.Fprintf(os.Stderr, "wharfinger-agent setup: step %d failed: %v\n", i+1, err)
			os.Exit(1)
		}
	}
	fmt.Println("wharfinger-agent setup: done")
}
