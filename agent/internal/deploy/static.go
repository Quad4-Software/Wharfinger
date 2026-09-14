package deploy

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	// staticMaxFiles and staticMaxBytes bound a staged artifact
	// tree; a runaway or hostile checkout cannot fill the disk.
	staticMaxFiles = 20_000
	staticMaxBytes = 256 << 20
	// staticKeepReleases retains the live release plus one previous
	// tree for inspection and fast rollback.
	staticKeepReleases = 2
)

// isStaticSpec reports whether the job publishes files to the edge
// static path instead of running a container: a static source, or
// an explicit static build on a repo checkout.
func isStaticSpec(s *Spec) bool {
	return s.Source.Kind == "static" || s.Build.Kind == "static"
}

// executeStatic is the artifact pipeline: clone or reuse a
// pre-staged checkout, export the tree into a per-release dir,
// verify the serve root, then repoint the app symlink the edge
// routes resolve (src/<app> is the hub-declared staticRoot). The
// previous tree keeps serving until the atomic swap, so a failed
// stage never takes the site down.
func (e *Executor) executeStatic(
	ctx context.Context,
	job *Job,
	spec *Spec,
	entry JournalEntry,
	prog *progressWriter,
	out io.Writer,
	jobLog *ringBuf,
	needles [][]byte,
) error {
	fail := func(step string, cause error) error {
		return e.finishFail(job, entry, step, cause,
			tail(scrubText(jobLog.String(), needles), failTailCap))
	}
	link := filepath.Join(e.stateDir, "src", spec.AppID)
	subdir := spec.Source.Subdir
	if subdir == "" {
		subdir = spec.Build.Context
	}
	commit := ""
	if spec.Source.URL == "" {
		// Pre-staged tree: an earlier deploy or the operator already
		// placed the files at the app link; verify and report.
		entry.Step = StepHealth
		e.saveJournal(entry)
		if _, err := verifyStaticRoot(link, subdir); err != nil {
			return fail(StepHealth, err)
		}
		fmt.Fprintf(out, "serving pre-staged tree at %s\n", link)
	} else {
		repoDir := filepath.Join(e.stateDir, "static", spec.AppID, "repo")
		relDir := filepath.Join(e.stateDir, "static", spec.AppID, "rel-"+spec.ReleaseID)

		entry.Step = StepFetch
		e.saveJournal(entry)
		keyFile, err := underDir(e.stateDir, spec.Source.KeyFile)
		if err != nil {
			return fail(StepFetch, err)
		}
		ref := spec.Source.Ref
		if spec.Source.Commit != "" {
			ref = spec.Source.Commit
		}
		fmt.Fprintf(out, "cloning %s @ %s\n", spec.Source.URL, ref)
		if err := e.git.CloneOrFetch(ctx, repoDir, spec.Source.URL, ref, keyFile, out); err != nil {
			return fail(StepFetch, err)
		}
		commit, _ = e.git.RevParse(ctx, repoDir, "HEAD")
		prog.Flush()

		// Export to a fresh per-release dir so the live tree never
		// serves a half-written checkout.
		entry.Step = StepBuild
		e.saveJournal(entry)
		_ = os.RemoveAll(relDir)
		files, skipped, err := copyTree(repoDir, relDir)
		if err != nil {
			_ = os.RemoveAll(relDir)
			return fail(StepBuild, err)
		}
		fmt.Fprintf(out, "staged %d files into %s", files, relDir)
		if skipped > 0 {
			fmt.Fprintf(out, " (%d non-regular entries skipped)", skipped)
		}
		fmt.Fprintln(out)
		prog.Flush()

		entry.Step = StepHealth
		e.saveJournal(entry)
		if _, err := verifyStaticRoot(relDir, subdir); err != nil {
			return fail(StepHealth, err)
		}

		if err := swapStaticRoot(link, relDir); err != nil {
			return fail(StepPublish, err)
		}
		// The publish marker is journaled after the swap: a crash
		// before this write reconciles as failed even if the rename
		// landed, and the hub can then roll back to a known state.
		entry.Step = StepPublish
		e.saveJournal(entry)
		e.pruneStaticReleases(spec.AppID, spec.ReleaseID, out)
		prog.Flush()
	}

	entry.Step = StepSucceed
	e.saveJournal(entry)
	result := map[string]any{
		"releaseId": spec.ReleaseID,
		"jobKey":    spec.JobKey,
		"static":    true,
	}
	if commit != "" {
		result["commit"] = commit
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

// copyTree exports a checkout into dst: directories and regular
// files only. .git metadata is skipped anywhere it appears and
// symlinks are dropped, so nothing in the served tree can point
// outside the state dir jail.
func copyTree(src, dst string) (files int, skipped int, err error) {
	var total int64
	err = filepath.WalkDir(src, func(p string, d fs.DirEntry, werr error) error {
		if werr != nil {
			return werr
		}
		rel, rerr := filepath.Rel(src, p)
		if rerr != nil {
			return rerr
		}
		if rel == "." {
			return nil
		}
		if d.Name() == ".git" {
			if d.IsDir() {
				return filepath.SkipDir
			}
			skipped++
			return nil
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		info, ierr := d.Info()
		if ierr != nil {
			return ierr
		}
		if !info.Mode().IsRegular() {
			skipped++
			return nil
		}
		files++
		total += info.Size()
		if files > staticMaxFiles {
			return fmt.Errorf("artifact tree exceeds %d files", staticMaxFiles)
		}
		if total > staticMaxBytes {
			return fmt.Errorf("artifact tree exceeds %d bytes", staticMaxBytes)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		return copyFile(p, target)
	})
	return files, skipped, err
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// verifyStaticRoot resolves the serve dir under a staged tree and
// requires it to hold at least one regular file; an empty artifact
// root is a failed release, not a live 404 site.
func verifyStaticRoot(root, subdir string) (string, error) {
	dir, err := secureJoin(root, subdir)
	if err != nil {
		return "", err
	}
	st, err := os.Stat(dir)
	if err != nil {
		return "", fmt.Errorf("static root %q: %w", subdir, err)
	}
	if !st.IsDir() {
		return "", fmt.Errorf("static root %q is not a directory", subdir)
	}
	found := false
	werr := filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || found {
			return err
		}
		if d.Type().IsRegular() {
			found = true
			return fs.SkipAll
		}
		return nil
	})
	if werr != nil {
		return "", werr
	}
	if !found {
		return "", fmt.Errorf("static root %q has no files", subdir)
	}
	return dir, nil
}

// swapStaticRoot atomically repoints the app link at target. The
// edge resolves src/<app>/<subdir> lexically and lets the kernel
// follow the symlink, so traffic moves in one rename. A real
// directory already sitting at the link (a legacy git checkout or
// manual staging) is moved aside first; that migration window is
// the only non-atomic moment and happens once per app.
func swapStaticRoot(link, target string) error {
	tmp := link + ".swap"
	_ = os.Remove(tmp)
	if err := os.Symlink(target, tmp); err != nil {
		return err
	}
	if st, err := os.Lstat(link); err == nil && st.Mode()&os.ModeSymlink == 0 {
		hold := link + ".hold"
		_ = os.RemoveAll(hold)
		if err := os.Rename(link, hold); err != nil {
			_ = os.Remove(tmp)
			return err
		}
		defer os.RemoveAll(hold)
	}
	return os.Rename(tmp, link)
}

// pruneStaticReleases drops all but the newest release trees under
// the app's static dir; the shared repo checkout is always kept.
func (e *Executor) pruneStaticReleases(appID, keep string, out io.Writer) {
	dir := filepath.Join(e.stateDir, "static", appID)
	des, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type rel struct {
		name string
		mod  time.Time
	}
	var rels []rel
	for _, de := range des {
		if !de.IsDir() || !strings.HasPrefix(de.Name(), "rel-") {
			continue
		}
		if de.Name() == "rel-"+keep {
			continue
		}
		info, err := de.Info()
		if err != nil {
			continue
		}
		rels = append(rels, rel{de.Name(), info.ModTime()})
	}
	sort.Slice(rels, func(a, b int) bool { return rels[a].mod.After(rels[b].mod) })
	for i, r := range rels {
		if i < staticKeepReleases-1 {
			continue
		}
		if err := os.RemoveAll(filepath.Join(dir, r.name)); err == nil {
			fmt.Fprintf(out, "pruned old release tree %s\n", r.name)
		}
	}
}
