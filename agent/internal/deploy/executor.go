package deploy

import (
	"context"
	"crypto/ed25519"
	"encoding/pem"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

const (
	// jobTimeout bounds the whole deploy; individual ops have their
	// own tighter limits.
	jobTimeout = 20 * time.Minute
	// heartbeatEvery keeps the hub lease alive during long steps;
	// the hub lease itself is 120s.
	heartbeatEvery = 30 * time.Second
	// drainAfterHealth is the grace window between health passing
	// and the old container stopping, so in-flight requests on the
	// old release can finish.
	drainAfterHealth = 5 * time.Second
	// noHealthObserve is the observation window for apps without a
	// spec healthcheck: the new container must simply stay up.
	noHealthObserve = 10 * time.Second
	// jobLogCap bounds captured step output (1MB ring).
	jobLogCap = 1 << 20
	// failTailCap bounds the log tail attached to a failure report.
	failTailCap = 2 * 1024
	// healthWindowCap bounds the spec-provided healthcheck window.
	healthWindowCap = 10 * time.Minute
)

// probeHTTP is shared across healthcheck probes; the per-probe ctx
// carries the timeout.
var probeHTTP = &http.Client{}

// Executor runs claimed deploy jobs end to end against the local
// container runtime. One job at a time: the caller serializes
// Execute calls.
type Executor struct {
	hub      *Client
	journal  *Journal
	runner   CmdRunner
	stateDir string
	rt       *Runtime // container runtime; nil when none detected
	kube     *Kube    // k8s runtime; nil when no kubectl/kubeconfig
	git      *Git
}

// NewExecutor detects the available deploy runtimes: a container
// runtime (podman, then docker) and a kubectl/kubeconfig pair. An
// executor exists when at least one works; with neither, deploys are
// disabled and the agent never advertises the deploy capability.
func NewExecutor(stateDir string, hub *Client, runner CmdRunner, kubeconfig string) (*Executor, error) {
	if runner == nil {
		runner = ExecRunner{}
	}
	e := &Executor{
		hub:      hub,
		journal:  NewJournal(stateDir),
		runner:   runner,
		stateDir: stateDir,
		git:      NewGit(runner),
	}
	rt, rtErr := DetectRuntime("", runner)
	if rtErr == nil {
		e.rt = rt
	}
	kb, kbErr := DetectKube(kubeconfig, runner)
	if kbErr == nil {
		e.kube = kb
	}
	if e.rt == nil && e.kube == nil {
		return nil, fmt.Errorf("no deploy runtime (%v; %v)", rtErr, kbErr)
	}
	return e, nil
}

// RuntimeName reports the detected runtimes, for startup logging.
func (e *Executor) RuntimeName() string {
	var names []string
	if e.rt != nil {
		names = append(names, e.rt.Name)
	}
	if e.kube != nil {
		names = append(names, RuntimeK8s)
	}
	return strings.Join(names, "+")
}

// KubeAvailable reports whether k8s specs can run here.
func (e *Executor) KubeAvailable() bool { return e.kube != nil }

// KubeSource reports which kubeconfig discovery step was used, for
// startup logging.
func (e *Executor) KubeSource() string {
	if e.kube == nil {
		return ""
	}
	return e.kube.Source
}

// Claim asks the hub for the next deploy job; nil means none queued.
func (e *Executor) Claim(ctx context.Context) (*Job, error) {
	return e.hub.Claim(ctx)
}

// runtimeFor honors a spec-pinned runtime when it differs from the
// detected default; an unresolvable pin is a spec error. k8s never
// reaches here: Execute routes it to executeKube first.
func (e *Executor) runtimeFor(prefer string) (*Runtime, error) {
	if e.rt != nil && (prefer == "" || prefer == e.rt.Name) {
		return e.rt, nil
	}
	if prefer == "" {
		return nil, fmt.Errorf("no container runtime detected")
	}
	return DetectRuntime(prefer, e.runner)
}

// Execute runs one claimed job to a terminal report. The zero-gap
// rule holds throughout: the previous container is never stopped
// before the replacement passes health, and failures report
// prevKept so the hub decides whether a rollback job follows.
func (e *Executor) Execute(ctx context.Context, job *Job) error {
	spec, err := ParseSpec(job.Spec)
	if err != nil {
		return e.finishFail(job, JournalEntry{JobID: job.ID, Lease: job.Lease},
			"spec", err, "")
	}
	if spec.Runtime == RuntimeK8s {
		return e.executeKube(ctx, job, spec)
	}
	rt, err := e.runtimeFor(spec.Runtime)
	if err != nil {
		return e.finishFail(job, JournalEntry{JobID: job.ID, Lease: job.Lease},
			"spec", err, "")
	}

	jctx, cancel := context.WithTimeout(ctx, jobTimeout)
	defer cancel()

	prog := newProgress(jctx, e.hub, job)
	defer prog.Flush()
	// All step output tees to the hub log and a bounded local ring;
	// failure reports attach the ring tail.
	jobLog := newRingBuf(jobLogCap)
	out := io.MultiWriter(prog, jobLog)

	if ok, _ := e.hub.Action(jctx, job.ID, job.Lease, "start", "", nil); !ok {
		// The lease was already lost between claim and start;
		// another attempt owns this job now. Drop any stale journal
		// entry for this id so a later reconcile cannot misreport a
		// job we never ran.
		_ = e.journal.Remove(job.ID)
		return fmt.Errorf("job %d: lease rejected on start", job.ID)
	}
	defer close(e.heartbeatLoop(jctx, job, cancel))

	entry := JournalEntry{
		JobID:     job.ID,
		Lease:     job.Lease,
		ReleaseID: spec.ReleaseID,
		Container: spec.ContainerName(),
		Runtime:   rt.Name,
	}
	if prev := spec.Prev(); prev != nil {
		entry.Prev = prev.Name
	}

	started := false     // whether the new container may exist
	var needles [][]byte // env values tracked for redaction
	fail := func(step string, cause error) error {
		if started {
			if lt := e.logTail(rt, spec.ContainerName()); lt != "" {
				prog.Note(scrubText("container logs:\n"+lt, needles))
				prog.Flush()
			}
			// The replacement is removed on failure; the previous
			// container is left running (zero-gap rule).
			_ = rt.Remove(context.Background(), spec.ContainerName())
		}
		return e.finishFail(job, entry, step, cause,
			tail(scrubText(jobLog.String(), needles), failTailCap))
	}

	// Secrets come down once per job over the proof-signed channel:
	// the env map lands in an env file and a present deploy key lands
	// as an openssh key file. Both are scrubbed from disk on return,
	// and every tracked value is redacted out of the log stream so a
	// build echoing its own env cannot leak secrets into job logs.
	var envFile, keyFile string
	envFile, keyFile, needles, err = e.prepareSecrets(jctx, job, spec, out)
	if err != nil {
		return fail(StepFetch, err)
	}
	if envFile != "" {
		spec.Run.EnvFile = envFile
		defer func() { _ = os.Remove(envFile) }()
	}
	if keyFile != "" {
		spec.Source.KeyFile = keyFile
		defer func() { _ = os.Remove(keyFile) }()
	}
	if len(needles) > 0 {
		scrub := &scrubWriter{w: out, needles: needles}
		out = scrub
		defer scrub.Flush()
	}

	entry.Step = StepFetch
	e.saveJournal(entry)
	prog.Note(fmt.Sprintf("deploy %s release %s (job %d attempt %d)",
		spec.AppID, spec.ReleaseID, job.ID, job.Attempt))
	workDir, err := e.fetch(jctx, spec, rt, out)
	if err != nil {
		return fail(StepFetch, err)
	}
	prog.Flush()

	entry.Step = StepBuild
	e.saveJournal(entry)
	imageRef, err := e.build(jctx, spec, rt, workDir, out)
	if err != nil {
		return fail(StepBuild, err)
	}
	entry.Image = imageRef
	prog.Flush()

	entry.Step = StepRun
	e.saveJournal(entry)
	if err := e.startContainer(jctx, spec, rt, imageRef, out); err != nil {
		return fail(StepRun, err)
	}
	started = true
	prog.Flush()

	entry.Step = StepHealth
	e.saveJournal(entry)
	if err := e.waitHealthy(jctx, spec, rt, out); err != nil {
		return fail(StepHealth, err)
	}

	entry.Step = StepStopPrev
	e.saveJournal(entry)
	select {
	case <-jctx.Done():
		return fail(StepStopPrev, jctx.Err())
	case <-time.After(drainAfterHealth):
	}
	if prev := spec.Prev(); prev != nil && prev.Name != spec.ContainerName() {
		if err := rt.Stop(jctx, prev.Name, 10); err != nil {
			prog.Note(fmt.Sprintf("warning: stop previous container %s: %v", prev.Name, err))
		}
	}

	entry.Step = StepSucceed
	e.saveJournal(entry)
	result := map[string]any{
		"container": spec.ContainerName(),
		"image":     imageRef,
		"releaseId": spec.ReleaseID,
		"jobKey":    spec.JobKey,
	}
	if d := spec.Domains(); len(d) > 0 {
		result["domains"] = d
	}
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

func (e *Executor) saveJournal(entry JournalEntry) {
	if err := e.journal.Save(entry); err != nil {
		// A journal write failure is logged but not fatal: losing
		// the journal costs reconcile fidelity, not correctness of
		// the running deploy.
		log.Printf("journal: %v", err)
	}
}

// finishFail posts the terminal fail report. The journal records the
// failed step first so a crash before the post still reconciles as
// failed; the file is removed once the hub has the outcome.
func (e *Executor) finishFail(job *Job, entry JournalEntry, step string, cause error, logTail string) error {
	return e.finishOutcome(job, entry, step, cause, logTail, "fail")
}

// finishOutcome posts a terminal failure-family report: fail when
// local cleanup could not restore the previous state, rolled_back
// when it could (the k8s path reports rolled_back after a successful
// rollout undo). prevKept is always true: the zero-gap rule means
// the previous release is never stopped before health is proven.
func (e *Executor) finishOutcome(job *Job, entry JournalEntry, step string, cause error, logTail, action string) error {
	entry.Step = StepFailed
	entry.Error = cause.Error()
	e.saveJournal(entry)
	result := map[string]any{
		"failedStep": step,
		"error":      cause.Error(),
		"prevKept":   true,
		"releaseId":  entry.ReleaseID,
	}
	if action == "rolled_back" {
		result["rolledBack"] = true
	}
	if logTail != "" {
		result["logTail"] = logTail
	}
	ok, err := e.hub.Action(context.Background(), job.ID, job.Lease, action, "", result)
	if err != nil {
		return fmt.Errorf("job %d: report %s: %w", job.ID, action, err)
	}
	if ok {
		_ = e.journal.Remove(job.ID)
	}
	return cause
}

// fetch resolves the source checkout dir for git/static kinds and
// pulls the image for image kind. It returns the checkout dir, or ""
// when the source needs no local tree.
func (e *Executor) fetch(ctx context.Context, spec *Spec, rt *Runtime, out io.Writer) (string, error) {
	switch spec.Source.Kind {
	case "git":
		dir := filepath.Join(e.stateDir, "src", spec.AppID)
		keyFile, err := underDir(e.stateDir, spec.Source.KeyFile)
		if err != nil {
			return "", err
		}
		ref := spec.Source.Ref
		if spec.Source.Commit != "" {
			ref = spec.Source.Commit
		}
		fmt.Fprintf(out, "cloning %s @ %s\n", spec.Source.URL, ref)
		if err := e.git.CloneOrFetch(ctx, dir, spec.Source.URL, ref, keyFile, out); err != nil {
			return "", err
		}
		return dir, nil
	case "image":
		fmt.Fprintf(out, "pulling %s\n", spec.effectiveImage())
		if err := rt.Pull(ctx, spec.effectiveImage(), out); err != nil {
			return "", err
		}
		return "", nil
	case "static":
		dir := filepath.Join(e.stateDir, "src", spec.AppID)
		if st, err := os.Stat(dir); err != nil || !st.IsDir() {
			return "", fmt.Errorf("static source dir %s missing", dir)
		}
		return dir, nil
	}
	return "", fmt.Errorf("source kind %q unsupported", spec.Source.Kind)
}

// build produces the image reference to run: a fresh local tag for
// dockerfile builds, or the registry image for static/image builds.
func (e *Executor) build(ctx context.Context, spec *Spec, rt *Runtime, workDir string, out io.Writer) (string, error) {
	switch spec.Build.Kind {
	case "", "dockerfile":
		rel := spec.Build.Context
		if rel == "" {
			rel = spec.Source.Subdir
		}
		ctxDir, err := secureJoin(workDir, rel)
		if err != nil {
			return "", err
		}
		df := spec.Build.Dockerfile
		if df == "" {
			df = "Dockerfile"
		}
		dfPath, err := secureJoin(ctxDir, df)
		if err != nil {
			return "", err
		}
		tag := spec.ImageTag()
		fmt.Fprintf(out, "building %s (context %s)\n", tag, ctxDir)
		if err := rt.Build(ctx, ctxDir, dfPath, tag, spec.Build.Args, out); err != nil {
			return "", err
		}
		return tag, nil
	case "static", "image":
		// No local build: run the pulled/provided image. The
		// normalized name keeps the run ref identical to the pull
		// ref for podman short names.
		return rt.imageName(spec.effectiveImage()), nil
	}
	return "", fmt.Errorf("build kind %q unsupported", spec.Build.Kind)
}

var envKeyRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// prepareSecrets pulls the sealed material for the app referenced
// by spec.Run.EnvRef and stages it as files under the state dir:
// the env map becomes an env file and a present deploy key becomes
// an openssh private key. Only the lease holder can read either;
// both are mode 0600 and removed when Execute returns. Env values
// cannot carry newlines into an env file, so they are flattened.
func (e *Executor) prepareSecrets(
	ctx context.Context,
	job *Job,
	spec *Spec,
	out io.Writer,
) (string, string, [][]byte, error) {
	if spec.Run.EnvRef == "" {
		return "", "", nil, nil
	}
	sec, err := e.hub.Secrets(ctx, job.ID, job.Lease)
	if err != nil {
		return "", "", nil, fmt.Errorf("fetch secrets for %s: %w", spec.Run.EnvRef, err)
	}
	envFile, err := e.writeEnvFile(job.ID, sec.Env, out)
	if err != nil {
		return "", "", nil, err
	}
	keyFile := ""
	if len(sec.DeployKey) > 0 {
		keyFile, err = e.writeKeyFile(job.ID, sec.DeployKey)
		if err != nil {
			_ = os.Remove(envFile)
			return "", "", nil, err
		}
		fmt.Fprintln(out, "deploy key loaded")
	}
	return envFile, keyFile, secretNeedles(sec.Env), nil
}

// writeEnvFile renders the env map in env-file format under the
// job dir and reports only the count, never names or values.
func (e *Executor) writeEnvFile(jobID int64, env map[string]string, out io.Writer) (string, error) {
	var b strings.Builder
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if !envKeyRe.MatchString(k) {
			return "", fmt.Errorf("env key %q is not a valid name", k)
		}
		v := strings.Map(func(r rune) rune {
			if r == '\n' || r == '\r' {
				return ' '
			}
			return r
		}, env[k])
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(v)
		b.WriteByte('\n')
	}
	path := filepath.Join(e.stateDir, "jobs", fmt.Sprintf("env-%d", jobID))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o600); err != nil {
		return "", err
	}
	fmt.Fprintf(out, "loaded %d environment variables\n", len(keys))
	return path, nil
}

// writeKeyFile encodes the raw ed25519 deploy key in the openssh
// private format ssh -i accepts.
func (e *Executor) writeKeyFile(jobID int64, raw []byte) (string, error) {
	block, err := ssh.MarshalPrivateKey(ed25519.PrivateKey(raw), "wharfinger-deploy")
	if err != nil {
		return "", fmt.Errorf("marshal deploy key: %w", err)
	}
	path := filepath.Join(e.stateDir, "jobs", fmt.Sprintf("key-%d", jobID))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, pem.EncodeToMemory(block), 0o600); err != nil {
		return "", err
	}
	return path, nil
}

// startContainer removes any leftover container of the same name
// (retry of a failed attempt) and starts the release container.
func (e *Executor) startContainer(ctx context.Context, spec *Spec, rt *Runtime, image string, out io.Writer) error {
	name := spec.ContainerName()
	envFile, err := underDir(e.stateDir, spec.Run.EnvFile)
	if err != nil {
		return err
	}
	_ = rt.Remove(ctx, name)
	fmt.Fprintf(out, "starting %s from %s\n", name, image)
	return rt.RunContainer(ctx, RunOptions{
		Name:    name,
		Image:   image,
		EnvFile: envFile,
		Ports:   spec.Run.Ports,
	}, out)
}

// waitHealthy blocks until the new container passes its healthcheck
// or the window closes. With no spec healthcheck the container only
// has to stay running for a short observation window; either way the
// previous container is untouched until this returns nil.
func (e *Executor) waitHealthy(ctx context.Context, spec *Spec, rt *Runtime, out io.Writer) error {
	name := spec.ContainerName()
	hc := spec.Run.Healthcheck
	if hc == nil {
		return e.observeUp(ctx, name, rt, out)
	}

	window := 2 * time.Minute
	interval := 2 * time.Second
	if hc.TimeoutMs > 0 {
		window = time.Duration(hc.TimeoutMs) * time.Millisecond
	}
	if hc.IntervalMs > 0 {
		interval = time.Duration(hc.IntervalMs) * time.Millisecond
	}
	if window > healthWindowCap {
		window = healthWindowCap
	}
	if interval < 250*time.Millisecond {
		interval = 250 * time.Millisecond
	}
	probeTimeout := min(interval, 5*time.Second)
	deadline := time.Now().Add(window)

	fails := 0
	downStreak := 0
	for {
		insp, ierr := rt.Inspect(ctx, name)
		if ierr == nil && insp.Found {
			if insp.Health == "healthy" {
				// An image-defined HEALTHCHECK passing also
				// satisfies the spec check.
				return nil
			}
			if !insp.Running {
				downStreak++
				// An exited or crash-looping container cannot
				// recover within the window; bail early.
				if downStreak >= 3 || insp.RestartCount >= 5 {
					return fmt.Errorf("container %s down (status %s, exit %d, restarts %d)",
						name, insp.Status, insp.ExitCode, insp.RestartCount)
				}
			} else {
				downStreak = 0
			}
			if e.probe(ctx, spec, insp, probeTimeout) {
				return nil
			}
		}
		fails++
		if hc.Retries > 0 && fails >= hc.Retries {
			return fmt.Errorf("healthcheck failed %d probes", fails)
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("healthcheck did not pass within %s", window)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}
	}
}

// observeUp is the no-healthcheck slow path: the container must
// remain running for the observation window.
func (e *Executor) observeUp(ctx context.Context, name string, rt *Runtime, out io.Writer) error {
	fmt.Fprintf(out, "no healthcheck in spec; observing %s for %s\n", name, noHealthObserve)
	deadline := time.Now().Add(noHealthObserve)
	for time.Now().Before(deadline) {
		insp, err := rt.Inspect(ctx, name)
		if err == nil && insp.Found && !insp.Running {
			return fmt.Errorf("container %s exited (status %s, exit %d)",
				name, insp.Status, insp.ExitCode)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return nil
}

// probe runs one healthcheck probe against the resolved target.
func (e *Executor) probe(ctx context.Context, spec *Spec, insp InspectResult, timeout time.Duration) bool {
	hc := spec.Run.Healthcheck
	host, port := healthTarget(spec, insp)
	if host == "" {
		return false
	}
	pctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	switch hc.Kind {
	case "tcp":
		c, err := (&net.Dialer{}).DialContext(pctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
		if err != nil {
			return false
		}
		c.Close()
		return true
	default: // http
		path := hc.Path
		if path == "" {
			path = "/"
		}
		if !strings.HasPrefix(path, "/") {
			path = "/" + path
		}
		u := "http://" + net.JoinHostPort(host, strconv.Itoa(port)) + path
		req, err := http.NewRequestWithContext(pctx, http.MethodGet, u, nil)
		if err != nil {
			return false
		}
		res, err := probeHTTP.Do(req)
		if err != nil {
			return false
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4<<10))
		res.Body.Close()
		return res.StatusCode < 400
	}
}

// healthTarget resolves where to probe: a published host port for
// the healthcheck port first (works for rootless podman where the
// container IP is not always reachable), then the container IP.
func healthTarget(spec *Spec, insp InspectResult) (string, int) {
	hc := spec.Run.Healthcheck
	for _, p := range spec.Run.Ports {
		if p.Container == hc.Port {
			return "127.0.0.1", p.Host
		}
	}
	for _, ip := range insp.IPs {
		if ip != "" {
			return ip, hc.Port
		}
	}
	return "", 0
}

// logTail grabs the last container log lines for a failure report.
// Best effort: a dead runtime just yields an empty tail.
func (e *Executor) logTail(rt *Runtime, name string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	s, err := rt.Logs(ctx, name, 80)
	if err != nil {
		return ""
	}
	return tail(s, failTailCap)
}

// Reconcile reports journaled jobs at startup so the hub can close
// out jobs it marked unknown. Each entry maps to an outcome from its
// last recorded step plus the container state observed now; the hub
// only applies reports for jobs it already flagged unknown.
func (e *Executor) Reconcile(ctx context.Context) error {
	entries, err := e.journal.Entries()
	if err != nil || len(entries) == 0 {
		return err
	}
	items := make([]ReconcileItem, 0, len(entries))
	for _, en := range entries {
		items = append(items, e.reconcileItem(ctx, en))
	}
	if err := e.hub.Reconcile(ctx, items); err != nil {
		return err
	}
	for _, en := range entries {
		_ = e.journal.Remove(en.JobID)
	}
	return nil
}

func (e *Executor) reconcileItem(ctx context.Context, en JournalEntry) ReconcileItem {
	// Steps at or past the zero-gap point had already proven health
	// before the agent stopped, so the swap outcome is success.
	outcome := "failed"
	if en.Step == StepStopPrev || en.Step == StepSucceed {
		outcome = "succeeded"
	}
	result := map[string]any{
		"reconciled": true,
		"lastStep":   en.Step,
		"releaseId":  en.ReleaseID,
		"prevKept":   true,
	}
	if en.Container != "" {
		result["container"] = en.Container
		if en.Runtime == RuntimeK8s {
			e.kubeReconcile(ctx, en, result)
		} else {
			rt := e.rt
			if rt == nil || (en.Runtime != "" && en.Runtime != rt.Name) {
				if r2, err := e.runtimeFor(en.Runtime); err == nil {
					rt = r2
				}
			}
			if rt != nil {
				if insp, err := rt.Inspect(ctx, en.Container); err == nil {
					result["containerRunning"] = insp.Running
					result["containerStatus"] = insp.Status
				}
			}
		}
	}
	if en.Image != "" {
		result["image"] = en.Image
	}
	if en.Error != "" {
		result["error"] = en.Error
	}
	return ReconcileItem{ID: en.JobID, Outcome: outcome, Result: result}
}
