package deploy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Per-operation timeouts. Builds and pulls get the long budget;
// everything else is a control call that should answer in seconds.
const (
	pullTimeout  = 10 * time.Minute
	buildTimeout = 10 * time.Minute
	opTimeout    = 60 * time.Second
)

// RunOptions describes one container start. Fields map to fixed
// flags; no free-form arguments exist.
type RunOptions struct {
	Name    string
	Image   string
	EnvFile string
	Ports   []Port
	Restart string
}

// InspectResult is the subset of container inspect the executor
// needs: liveness, image-defined health, and how to reach it.
type InspectResult struct {
	Found        bool
	Running      bool
	Status       string
	Health       string // "", "healthy", "unhealthy", "starting"
	ExitCode     int
	RestartCount int
	IPs          []string
}

// Runtime is a detected container runtime CLI (podman preferred,
// docker as fallback) plus the runner that executes its argv.
type Runtime struct {
	Name   string // "podman" | "docker"
	Bin    string
	runner CmdRunner
}

// DetectRuntime probes podman first (the rootless default) and then
// docker, preferring the runtime named in prefer when given. A
// runtime counts only when its binary answers the version probe.
func DetectRuntime(prefer string, r CmdRunner) (*Runtime, error) {
	order := []string{"podman", "docker"}
	if prefer == "docker" || prefer == "podman" {
		order = []string{prefer, map[string]string{"podman": "docker", "docker": "podman"}[prefer]}
	}
	for _, name := range order {
		bin := resolveBin(name)
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		err := r.Run(ctx, []string{bin, "version"}, CmdOpts{}, io.Discard)
		cancel()
		if err == nil {
			return &Runtime{Name: name, Bin: bin, runner: r}, nil
		}
	}
	return nil, fmt.Errorf("no working container runtime (tried %s)", strings.Join(order, ", "))
}

// imageName qualifies short image names for podman: an ambiguous
// short name makes podman prompt for a registry, which would hang a
// deploy until timeout. Docker resolves the same names implicitly.
func (r *Runtime) imageName(image string) string {
	if r.Name != "podman" {
		return image
	}
	first := strings.SplitN(image, "/", 2)[0]
	if len(strings.SplitN(image, "/", 2)) == 1 ||
		(!strings.ContainsAny(first, ".:") && first != "localhost") {
		return "docker.io/" + image
	}
	return image
}

func (r *Runtime) run(ctx context.Context, argv []string, opts CmdOpts, out io.Writer) error {
	return r.runner.Run(ctx, argv, opts, out)
}

// Pull fetches an image. out receives bounded progress output.
func (r *Runtime) Pull(ctx context.Context, image string, out io.Writer) error {
	ctx, cancel := context.WithTimeout(ctx, pullTimeout)
	defer cancel()
	return r.run(ctx, pullArgv(r.Bin, r.imageName(image)), CmdOpts{}, out)
}

// Build runs a dockerfile build tagged <app>:<release>.
func (r *Runtime) Build(ctx context.Context, dir, dockerfile, tag string, args map[string]string, out io.Writer) error {
	ctx, cancel := context.WithTimeout(ctx, buildTimeout)
	defer cancel()
	return r.run(ctx, buildArgv(r.Bin, dir, dockerfile, tag, args), CmdOpts{Dir: dir}, out)
}

// RunContainer starts the detached app container.
func (r *Runtime) RunContainer(ctx context.Context, o RunOptions, out io.Writer) error {
	ctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	return r.run(ctx, runArgv(r.Bin, o), CmdOpts{}, out)
}

// Stop sends SIGTERM with a grace window, then SIGKILL.
func (r *Runtime) Stop(ctx context.Context, name string, graceSec int) error {
	ctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	return r.run(ctx, stopArgv(r.Bin, name, graceSec), CmdOpts{}, io.Discard)
}

// Remove force-removes a container; a missing container is an error
// the caller may ignore when removing best-effort.
func (r *Runtime) Remove(ctx context.Context, name string) error {
	ctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	return r.run(ctx, rmArgv(r.Bin, name), CmdOpts{}, io.Discard)
}

// ListByPrefix returns container names that begin with prefix. The
// runtime name filter is a substring match, so results are
// prefix-checked here before the caller acts on them.
func (r *Runtime) ListByPrefix(ctx context.Context, prefix string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	ring := newRingBuf(1 << 20)
	err := r.run(ctx, []string{
		r.Bin, "ps", "-a", "--filter", "name=" + prefix, "--format", "{{.Names}}",
	}, CmdOpts{}, ring)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, name := range strings.Split(ring.String(), "\n") {
		name = strings.TrimSpace(name)
		if strings.HasPrefix(name, prefix) {
			out = append(out, name)
		}
	}
	return out, nil
}

// ImagesByPrefix returns image refs (repo:tag) under the app's
// <app>:<release> tag convention, prefix-checked after the runtime's
// substring reference filter.
func (r *Runtime) ImagesByPrefix(ctx context.Context, prefix string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	ring := newRingBuf(1 << 20)
	err := r.run(ctx, []string{
		r.Bin, "images", "--filter", "reference=" + prefix + "*", "--format", "{{.Repository}}:{{.Tag}}",
	}, CmdOpts{}, ring)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, ref := range strings.Split(ring.String(), "\n") {
		ref = strings.TrimSpace(ref)
		if strings.HasPrefix(ref, prefix) {
			out = append(out, ref)
		}
	}
	return out, nil
}

// RemoveImage force-removes one image ref; a missing image is an
// error the caller may ignore when removing best-effort.
func (r *Runtime) RemoveImage(ctx context.Context, ref string) error {
	ctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	return r.run(ctx, []string{r.Bin, "rmi", "-f", ref}, CmdOpts{}, io.Discard)
}

// Inspect returns the observed state of one container. A container
// that does not exist yields Found=false without an error.
func (r *Runtime) Inspect(ctx context.Context, name string) (InspectResult, error) {
	ctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	ring := newRingBuf(1 << 20)
	err := r.run(ctx, inspectArgv(r.Bin, name), CmdOpts{}, ring)
	if err != nil {
		if notFound(ring.String()) {
			return InspectResult{}, nil
		}
		return InspectResult{}, err
	}
	return parseInspect(ring.String())
}

// Logs returns at most the last tail lines of container output,
// bounded in memory by the ring.
func (r *Runtime) Logs(ctx context.Context, name string, tail int) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	ring := newRingBuf(64 << 10)
	if err := r.run(ctx, logsArgv(r.Bin, name, tail), CmdOpts{}, ring); err != nil {
		return "", err
	}
	return ring.String(), nil
}

// notFound matches the missing-container diagnostics docker and
// podman print on a failed inspect.
func notFound(out string) bool {
	l := strings.ToLower(out)
	return strings.Contains(l, "no such") || strings.Contains(l, "not found") ||
		strings.Contains(l, "no container")
}

// inspectDoc is the shared shape of docker inspect and
// podman inspect output for the fields we read.
type inspectDoc struct {
	State struct {
		Status     string `json:"Status"`
		Running    bool   `json:"Running"`
		ExitCode   int    `json:"ExitCode"`
		Restarting bool   `json:"Restarting"`
		Health     *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
	RestartCount    int `json:"RestartCount"`
	NetworkSettings struct {
		IPAddress string `json:"IPAddress"`
		Networks  map[string]struct {
			IPAddress string `json:"IPAddress"`
		} `json:"Networks"`
	} `json:"NetworkSettings"`
}

func parseInspect(raw string) (InspectResult, error) {
	var docs []inspectDoc
	if err := json.Unmarshal([]byte(raw), &docs); err != nil {
		return InspectResult{}, fmt.Errorf("inspect json: %w", err)
	}
	if len(docs) == 0 {
		return InspectResult{}, nil
	}
	d := docs[0]
	res := InspectResult{
		Found:        true,
		Running:      d.State.Running,
		Status:       d.State.Status,
		ExitCode:     d.State.ExitCode,
		RestartCount: d.RestartCount,
	}
	if d.State.Health != nil {
		res.Health = d.State.Health.Status
	}
	if ip := d.NetworkSettings.IPAddress; ip != "" {
		res.IPs = append(res.IPs, ip)
	}
	for _, n := range d.NetworkSettings.Networks {
		if n.IPAddress != "" {
			res.IPs = append(res.IPs, n.IPAddress)
		}
	}
	return res, nil
}

// argv builders. Kept pure and exported to tests through the same
// package so argv shape is verified without a real runtime binary.

func pullArgv(bin, image string) []string {
	return []string{bin, "pull", image}
}

func buildArgv(bin, dir, dockerfile, tag string, args map[string]string) []string {
	argv := []string{bin, "build", "-t", tag}
	if dockerfile != "" {
		argv = append(argv, "-f", dockerfile)
	}
	// Sorted keys keep argv deterministic for tests and audit logs.
	keys := make([]string, 0, len(args))
	for k := range args {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		argv = append(argv, "--build-arg", k+"="+args[k])
	}
	return append(argv, dir)
}

func runArgv(bin string, o RunOptions) []string {
	argv := []string{bin, "run", "-d", "--name", o.Name}
	if o.EnvFile != "" {
		argv = append(argv, "--env-file", o.EnvFile)
	}
	for _, p := range o.Ports {
		mapping := strconv.Itoa(p.Host) + ":" + strconv.Itoa(p.Container)
		if p.Local {
			mapping = "127.0.0.1:" + mapping
		}
		argv = append(argv, "-p", mapping)
	}
	restart := o.Restart
	if restart == "" {
		restart = "unless-stopped"
	}
	return append(argv, "--restart", restart, o.Image)
}

func stopArgv(bin, name string, graceSec int) []string {
	return []string{bin, "stop", "-t", strconv.Itoa(graceSec), name}
}

func rmArgv(bin, name string) []string {
	return []string{bin, "rm", "-f", name}
}

func inspectArgv(bin, name string) []string {
	return []string{bin, "inspect", name}
}

func logsArgv(bin, name string, tail int) []string {
	return []string{bin, "logs", "--tail", strconv.Itoa(tail), name}
}
