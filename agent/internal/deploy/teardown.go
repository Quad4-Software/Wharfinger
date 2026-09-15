package deploy

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// executeTeardown removes everything one app owns on this agent:
// its containers and built images under the <app>-<release> and
// <app>:<release> conventions, its k8s deployments and services
// under the app label, and its checkout dirs under the state dir.
// Every step is idempotent and best-effort: a missing container or
// dir is success, so retries converge instead of failing.
func (e *Executor) executeTeardown(ctx context.Context, job *Job) error {
	spec, err := ParseTeardownSpec(job.Spec)
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

	var removed []string
	report := func(format string, args ...any) {
		prog.Write([]byte(fmt.Sprintf(format, args...) + "\n"))
	}

	if spec.Runtime == RuntimeK8s {
		if e.kube == nil {
			report("warning: teardown targets k8s but no kubeconfig detected")
		} else {
			ns := spec.Namespace
			if ns == "" {
				ns = "default"
			}
			if err := e.kube.DeleteApp(jctx, dns1123(spec.AppID), ns, io.Discard); err != nil {
				report("warning: k8s delete for %s in %s: %v", spec.AppID, ns, err)
			} else {
				removed = append(removed, "k8s:"+ns+"/"+dns1123(spec.AppID))
			}
		}
	} else if rt := e.rt; rt != nil {
		names, err := rt.ListByPrefix(jctx, spec.AppID+"-")
		if err != nil {
			report("warning: list containers for %s: %v", spec.AppID, err)
		}
		for _, name := range names {
			_ = rt.Stop(jctx, name, 10)
			if err := rt.Remove(jctx, name); err != nil {
				report("warning: remove container %s: %v", name, err)
			} else {
				removed = append(removed, name)
			}
		}
		images, err := rt.ImagesByPrefix(jctx, foldTagName(spec.AppID)+":")
		if err != nil {
			report("warning: list images for %s: %v", spec.AppID, err)
		}
		for _, ref := range images {
			if err := rt.RemoveImage(jctx, ref); err != nil {
				report("warning: remove image %s: %v", ref, err)
			} else {
				removed = append(removed, ref)
			}
		}
	} else {
		report("warning: no container runtime; removing checkout dirs only")
	}

	// The app link, the git checkout, and the static release trees all
	// live under per-app dirs; RemoveAll on a symlink drops the link,
	// never the target.
	for _, dir := range []string{
		filepath.Join(e.stateDir, "src", spec.AppID),
		filepath.Join(e.stateDir, "static", spec.AppID),
	} {
		if err := os.RemoveAll(dir); err != nil {
			report("warning: remove %s: %v", dir, err)
		}
	}

	// Flush before the terminal action: the deferred cancel kills
	// jctx, and a progress post on a dead context can reach the hub
	// truncated. succeed itself posts on the parent ctx.
	prog.Flush()
	result := map[string]any{"appId": spec.AppID, "removed": removed}
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
