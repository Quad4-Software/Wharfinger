package deploy

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// executeTask runs an operator verb: service control, package index
// refresh, package apply, or host reboot. Specs carry no secrets;
// every command is a fixed argv built from validated fields.
func (e *Executor) executeTask(ctx context.Context, job *Job) error {
	spec, err := ParseTaskSpec(job.Spec)
	if err != nil {
		return e.finishFail(job, JournalEntry{JobID: job.ID, Lease: job.Lease},
			"spec", err, "")
	}

	jctx, cancel := context.WithTimeout(ctx, jobTimeout)
	defer cancel()

	prog := newProgress(jctx, e.hub, job)
	defer prog.Flush()

	if ok, _ := e.hub.Action(jctx, job.ID, job.Lease, "start", "", nil); !ok {
		_ = e.journal.Remove(job.ID)
		return fmt.Errorf("job %d: lease rejected on start", job.ID)
	}
	defer close(e.heartbeatLoop(jctx, job, cancel))

	report := func(format string, args ...any) {
		prog.Write([]byte(fmt.Sprintf(format, args...) + "\n"))
	}

	// Task output tees to the hub log and a bounded ring so a failure
	// report can attach the tail.
	out := newRingBuf(failTailCap)
	log := io.MultiWriter(prog, out)

	result := map[string]any{"action": spec.Action}
	switch {
	case strings.HasPrefix(spec.Action, "service."):
		if err := e.serviceVerb(jctx, spec, log); err != nil {
			prog.Flush()
			return e.finishFail(job, JournalEntry{JobID: job.ID, Lease: job.Lease},
				"service", err, tail(out.String(), failTailCap))
		}
		result["unit"] = spec.Unit
	case spec.Action == "packages.refresh" || spec.Action == "packages.apply":
		if err := e.packageTask(jctx, spec, log); err != nil {
			prog.Flush()
			return e.finishFail(job, JournalEntry{JobID: job.ID, Lease: job.Lease},
				"packages", err, tail(out.String(), failTailCap))
		}
	case spec.Action == "host.reboot":
		// Report success before the reboot: once pid1 gets the
		// signal this process may die mid-flight, so the job must be
		// closed first. Preflight failures still report normally.
		if err := rebootPreflight(); err != nil {
			return e.finishFail(job, JournalEntry{JobID: job.ID, Lease: job.Lease},
				"reboot", err, "")
		}
		report("rebooting in %s; the agent returns when the host is back", rebootDelay)
		prog.Flush()
		if err := e.succeed(job, result); err != nil {
			return err
		}
		time.Sleep(rebootDelay)
		argv := rebootArgv()
		report("exec %s", strings.Join(argv, " "))
		prog.Flush()
		// The runner call likely never returns: the host is going
		// down. Any error here means the reboot failed after the
		// job closed, so it can only surface in the agent log.
		if err := e.runner.Run(context.Background(), argv, CmdOpts{}, io.Discard); err != nil {
			report("reboot command failed after job close: %v", err)
		}
		return nil
	default:
		return e.finishFail(job, JournalEntry{JobID: job.ID, Lease: job.Lease},
			"spec", fmt.Errorf("task action %q unsupported", spec.Action), "")
	}

	prog.Flush()
	return e.succeed(job, result)
}

// succeed posts the terminal succeed action and drops the journal.
func (e *Executor) succeed(job *Job, result map[string]any) error {
	ok, err := e.hub.Action(context.Background(), job.ID, job.Lease, "succeed", "", result)
	if err != nil {
		return fmt.Errorf("job %d: report succeed: %w", job.ID, err)
	}
	if !ok {
		return fmt.Errorf("job %d: succeed rejected (lease lost)", job.ID)
	}
	_ = e.journal.Remove(job.ID)
	return nil
}

// detectInit returns "systemd" when pid1 is systemd and "openrc"
// when the rc tools are present. The /run/systemd/system marker is
// created by systemd itself, so a leftover systemctl binary on a
// container image cannot fake it.
var detectInit = func() string {
	if _, err := os.Stat("/run/systemd/system"); err == nil {
		return "systemd"
	}
	if _, err := os.Stat(resolveBin("rc-service")); err == nil {
		return "openrc"
	}
	if _, err := os.Stat(resolveBin("systemctl")); err == nil {
		return "systemd"
	}
	return ""
}

// serviceArgv builds the fixed argv for a service verb under the
// given init system. systemd takes systemctl <verb> <unit>; OpenRC
// takes rc-service <name> <verb>. A bare service name gets the
// .service suffix under systemd.
func serviceArgv(init, action, unit string) []string {
	verb := strings.TrimPrefix(action, "service.")
	if init == "systemd" {
		if !strings.Contains(unit, ".") {
			unit += ".service"
		}
		return []string{resolveBin("systemctl"), verb, unit}
	}
	return []string{resolveBin("rc-service"), unit, verb}
}

func (e *Executor) serviceVerb(ctx context.Context, spec *TaskSpec, log io.Writer) error {
	init := detectInit()
	if init == "" {
		return fmt.Errorf("no supported init system (systemd or openrc)")
	}
	argv := serviceArgv(init, spec.Action, spec.Unit)
	fmt.Fprintf(log, "%s %s\n", spec.Action, spec.Unit)
	ctx2, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if err := e.runner.Run(ctx2, argv, CmdOpts{}, log); err != nil {
		return fmt.Errorf("%s %s: %w", spec.Action, spec.Unit, err)
	}
	return nil
}

// detectPkgManager picks the host's package manager by probing for
// its binary; order matches the collector's Updates probes.
var detectPkgManager = func() string {
	for _, m := range []struct {
		name string
		bin  string
	}{
		{"apt", "apt-get"},
		{"dnf", "dnf"},
		{"apk", "apk"},
		{"pacman", "pacman"},
		{"zypper", "zypper"},
	} {
		if _, err := os.Stat(resolveBin(m.bin)); err == nil {
			return m.name
		}
	}
	return ""
}

// pkgArgv maps a packages.* action to fixed manager argv.
// securityOnly is honored where the manager exposes a filter; the
// boolean return reports whether the flag was applied so the log
// can note a fallback to a full upgrade.
func pkgArgv(action, manager string, securityOnly bool) ([]string, bool) {
	bin := func(name string) string { return resolveBin(name) }
	if action == "packages.refresh" {
		switch manager {
		case "apt":
			return []string{bin("apt-get"), "update"}, true
		case "dnf":
			return []string{bin("dnf"), "check-update", "--refresh"}, true
		case "apk":
			return []string{bin("apk"), "update"}, true
		case "pacman":
			return []string{bin("pacman"), "-Sy", "--noconfirm"}, true
		case "zypper":
			return []string{bin("zypper"), "--non-interactive", "refresh"}, true
		}
		return nil, false
	}
	switch manager {
	case "apt":
		// apt has no supported security-only upgrade flag; a full
		// safe upgrade runs instead. confdef/confold keep conffile
		// prompts from hanging the job.
		return []string{
			bin("apt-get"), "-y",
			"-o", "Dpkg::Options::=--force-confdef",
			"-o", "Dpkg::Options::=--force-confold",
			"upgrade",
		}, false
	case "dnf":
		if securityOnly {
			return []string{bin("dnf"), "-y", "update", "--security"}, true
		}
		return []string{bin("dnf"), "-y", "update"}, true
	case "apk":
		return []string{bin("apk"), "upgrade", "--available"}, true
	case "pacman":
		return []string{bin("pacman"), "-Syu", "--noconfirm"}, true
	case "zypper":
		if securityOnly {
			return []string{bin("zypper"), "--non-interactive", "patch", "--category", "security"}, true
		}
		return []string{bin("zypper"), "--non-interactive", "update"}, true
	}
	return nil, false
}

func (e *Executor) packageTask(ctx context.Context, spec *TaskSpec, log io.Writer) error {
	manager := detectPkgManager()
	if manager == "" {
		return fmt.Errorf("no supported package manager detected")
	}
	argv, honored := pkgArgv(spec.Action, manager, spec.SecurityOnly)
	if argv == nil {
		return fmt.Errorf("manager %s has no mapping for %s", manager, spec.Action)
	}
	if spec.SecurityOnly && !honored {
		fmt.Fprintf(log, "securityOnly is not supported by %s; running a full upgrade\n", manager)
	}
	fmt.Fprintf(log, "%s via %s\n", spec.Action, manager)
	if err := e.runner.Run(ctx, argv, CmdOpts{Env: []string{"DEBIAN_FRONTEND=noninteractive"}}, log); err != nil {
		return fmt.Errorf("%s: %w", spec.Action, err)
	}
	return nil
}

// rebootDelay gives the succeed report time to flush before pid1
// tears the process down.
var rebootDelay = 5 * time.Second

// rebootPreflight fails the job early when no reboot mechanism is
// usable: a reboot command needs root and an init that honors it.
var rebootPreflight = func() error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("reboot requires root (agent euid %d)", os.Geteuid())
	}
	if rebootArgv() == nil {
		return fmt.Errorf("no reboot command found (systemctl, shutdown, reboot)")
	}
	return nil
}

var rebootArgv = func() []string {
	if _, err := os.Stat("/run/systemd/system"); err == nil {
		return []string{resolveBin("systemctl"), "reboot"}
	}
	if _, err := os.Stat(resolveBin("shutdown")); err == nil {
		return []string{resolveBin("shutdown"), "-r", "now"}
	}
	if _, err := os.Stat(resolveBin("reboot")); err == nil {
		return []string{resolveBin("reboot")}
	}
	return nil
}
