package deploy

// executor_kube.go holds the k8s execution path split out of
// executor.go per .agents/skills/safe-breakdown: same package, no
// behavior change, just file placement.

import (
	"context"
	"fmt"
	"io"
	"os"
	"time"
)

// executeKube runs a k8s deploy job. The cluster pulls the image
// itself, so there is no local fetch or build: the flow is secrets,
// manifest render, kubectl apply, rollout status, then cleanup of
// the previous release's deployment. The zero-gap rule maps onto
// deployment semantics: maxUnavailable 0 keeps old pods alive until
// new ones are ready, and a failed rollout either rolls back (retry
// of a known release) or deletes the new deployment while the old
// one keeps serving.
func (e *Executor) executeKube(ctx context.Context, job *Job, spec *Spec) error {
	entry := JournalEntry{
		JobID:     job.ID,
		Lease:     job.Lease,
		ReleaseID: spec.ReleaseID,
		Runtime:   RuntimeK8s,
	}
	if e.kube == nil {
		return e.finishFail(job, entry, "spec",
			fmt.Errorf("runtime k8s requested but no kubectl/kubeconfig is available"), "")
	}
	switch spec.Build.Kind {
	case "image", "static":
	default:
		return e.finishFail(job, entry, "spec",
			fmt.Errorf("k8s runtime does not build images locally; use an image source or run.image"), "")
	}
	if spec.effectiveImage() == "" {
		return e.finishFail(job, entry, "spec",
			fmt.Errorf("k8s deploy requires run.image or an image source"), "")
	}

	ns := spec.kubeNamespace()
	name := spec.kubeDeployName()
	entry.Container = name
	entry.Namespace = ns
	if prev := spec.Prev(); prev != nil {
		entry.Prev = prev.Name
	}

	jctx, cancel := context.WithTimeout(ctx, jobTimeout)
	defer cancel()

	prog := newProgress(jctx, e.hub, job)
	defer prog.Flush()
	jobLog := newRingBuf(jobLogCap)
	out := io.MultiWriter(prog, jobLog)

	if ok, _ := e.hub.Action(jctx, job.ID, job.Lease, "start", "", nil); !ok {
		_ = e.journal.Remove(job.ID)
		return fmt.Errorf("job %d: lease rejected on start", job.ID)
	}
	defer close(e.heartbeatLoop(jctx, job, cancel))

	var needles [][]byte
	envFile, keyFile, needles, err := e.prepareSecrets(jctx, job, spec, out)
	if err != nil {
		return e.finishFail(job, entry, StepFetch, err, "")
	}
	if envFile != "" {
		spec.Run.EnvFile = envFile
		defer func() { _ = os.Remove(envFile) }()
	}
	if keyFile != "" {
		// A deploy key is meaningless without a local checkout;
		// image sources never use it, but clean it up anyway.
		defer func() { _ = os.Remove(keyFile) }()
	}
	if len(needles) > 0 {
		scrub := &scrubWriter{w: out, needles: needles}
		out = scrub
		defer scrub.Flush()
	}

	fail := func(step string, cause error) error {
		return e.finishFail(job, entry, step, cause,
			tail(scrubText(jobLog.String(), needles), failTailCap))
	}

	entry.Step = StepFetch
	e.saveJournal(entry)
	var env map[string]string
	if spec.Run.EnvFile != "" {
		ef, err := underDir(e.stateDir, spec.Run.EnvFile)
		if err != nil {
			return fail(StepFetch, err)
		}
		if env, err = parseEnvFile(ef); err != nil {
			return fail(StepFetch, err)
		}
	}
	prog.Note(fmt.Sprintf("deploy %s release %s to k8s ns %s (job %d attempt %d, kubeconfig %s)",
		spec.AppID, spec.ReleaseID, ns, job.ID, job.Attempt, e.kube.Source))

	entry.Step = StepRun
	e.saveJournal(entry)
	doc, err := kubeApplyDoc(spec, env)
	if err != nil {
		return fail(StepRun, err)
	}
	fmt.Fprintf(out, "applying deployment %s in namespace %s\n", name, ns)
	if err := e.kube.Apply(jctx, doc, out); err != nil {
		// A partial apply may have created the deployment; remove it
		// best-effort. The previous release's deployment is a
		// separate object and stays untouched.
		_ = e.kube.DeleteDeployment(context.Background(), name, ns, io.Discard)
		return fail(StepRun, err)
	}
	entry.Image = spec.effectiveImage()
	prog.Flush()

	entry.Step = StepHealth
	e.saveJournal(entry)
	if spec.Run.Healthcheck == nil {
		// Same warning class as the container slow path: with no
		// probes the rollout can only gate on pod readiness, so a
		// crash-looping app still surfaces via the rollout deadline.
		fmt.Fprintln(out, "no healthcheck in spec; rollout gates on pod readiness only")
	}
	window := kubeRolloutWindow(spec)
	fmt.Fprintf(out, "waiting for rollout of %s (timeout %s)\n", name, window)
	if err := e.kube.RolloutStatus(jctx, name, ns, window, out); err != nil {
		// rollout undo restores the previous revision when this
		// release name was applied before (a job retry). On a first
		// attempt there is no history, so the failed deployment is
		// deleted instead; either way the previous release keeps
		// serving and the hub sees the matching outcome.
		if uerr := e.kube.RolloutUndo(context.Background(), name, ns, out); uerr == nil {
			prog.Note("rollout failed; reverted to previous revision")
			prog.Flush()
			return e.finishOutcome(job, entry, StepHealth, err,
				tail(scrubText(jobLog.String(), needles), failTailCap), "rolled_back")
		}
		_ = e.kube.DeleteDeployment(context.Background(), name, ns, io.Discard)
		return fail(StepHealth, err)
	}
	prog.Flush()

	entry.Step = StepStopPrev
	e.saveJournal(entry)
	select {
	case <-jctx.Done():
		return fail(StepStopPrev, jctx.Err())
	case <-time.After(drainAfterHealth):
	}
	if prev := spec.Prev(); prev != nil && dns1123(prev.Name) != name {
		prevName := dns1123(prev.Name)
		if err := e.kube.DeleteDeployment(jctx, prevName, ns, out); err != nil {
			prog.Note(fmt.Sprintf("warning: delete previous deployment %s: %v", prevName, err))
		}
	}

	entry.Step = StepSucceed
	e.saveJournal(entry)
	result := map[string]any{
		"container": name,
		"namespace": ns,
		"image":     spec.effectiveImage(),
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

// kubeReconcile fills the observed k8s state for a journaled job:
// the deployment's ready count plus a pod count by app label.
func (e *Executor) kubeReconcile(ctx context.Context, en JournalEntry, result map[string]any) {
	if e.kube == nil {
		return
	}
	st, err := e.kube.DeploymentStatus(ctx, en.Container, en.Namespace)
	if err != nil || !st.Found {
		return
	}
	result["containerRunning"] = st.Ready > 0
	result["containerStatus"] = fmt.Sprintf("%d/%d ready", st.Ready, st.Replicas)
	if st.AppLabel != "" {
		if total, running, err := e.kube.Pods(ctx, st.AppLabel, en.Namespace); err == nil {
			result["podsRunning"] = running
			result["podsTotal"] = total
		}
	}
}
