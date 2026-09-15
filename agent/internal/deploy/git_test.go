package deploy

import (
	"context"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"testing"
)

// fakeRunner records every argv and opts; failAt marks the call
// index that returns an error (-1 = never).
type fakeRunner struct {
	argv   [][]string
	opts   []CmdOpts
	failAt int
}

func (f *fakeRunner) Run(ctx context.Context, argv []string, opts CmdOpts, out io.Writer) error {
	f.argv = append(f.argv, append([]string(nil), argv...))
	f.opts = append(f.opts, opts)
	if f.failAt >= 0 && len(f.argv)-1 == f.failAt {
		return fmt.Errorf("forced failure")
	}
	return nil
}

func joined(calls [][]string) string {
	var b strings.Builder
	for _, c := range calls {
		b.WriteString(strings.Join(c, " "))
		b.WriteByte('\n')
	}
	return b.String()
}

func TestCloneOrFetchArgv(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "checkout")
	f := &fakeRunner{failAt: -1}
	g := &Git{Bin: "/usr/bin/git", runner: f}
	if err := g.CloneOrFetch(context.Background(), dir, "git@h:o/r.git", "main", "", CloneOpts{}, nil); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"/usr/bin/git init",
		"/usr/bin/git remote add origin git@h:o/r.git",
		"/usr/bin/git fetch --depth 1 origin main",
		"/usr/bin/git checkout -f FETCH_HEAD",
	}
	got := strings.Split(strings.TrimSuffix(joined(f.argv), "\n"), "\n")
	if len(got) != len(want) {
		t.Fatalf("calls:\n%s", joined(f.argv))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("call %d: got %q want %q", i, got[i], want[i])
		}
	}
	// Every call runs inside the checkout dir with prompt blocking.
	for _, o := range f.opts {
		if o.Dir != dir {
			t.Fatalf("dir: %q", o.Dir)
		}
		found := false
		for _, e := range o.Env {
			if e == "GIT_TERMINAL_PROMPT=0" {
				found = true
			}
			if strings.HasPrefix(e, "GIT_SSH_COMMAND") {
				t.Fatalf("no keyFile must mean no GIT_SSH_COMMAND, got %q", e)
			}
		}
		if !found {
			t.Fatalf("missing GIT_TERMINAL_PROMPT in %v", o.Env)
		}
	}
}

func TestCloneOrFetchRetrySetURL(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "checkout")
	// remote add fails on a reused checkout; set-url must follow.
	f := &fakeRunner{failAt: 1}
	g := &Git{Bin: "/usr/bin/git", runner: f}
	if err := g.CloneOrFetch(context.Background(), dir, "git@h:o/r.git", "v2", "", CloneOpts{}, nil); err != nil {
		t.Fatal(err)
	}
	j := joined(f.argv)
	if !strings.Contains(j, "remote set-url origin git@h:o/r.git") {
		t.Fatalf("expected set-url fallback, got:\n%s", j)
	}
	if !strings.Contains(j, "fetch --depth 1 origin v2") {
		t.Fatalf("expected fetch of ref v2, got:\n%s", j)
	}
}

func TestCloneOrFetchKeyFileEnv(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "checkout")
	f := &fakeRunner{failAt: -1}
	g := &Git{Bin: "/usr/bin/git", runner: f}
	key := "/state/keys/app_deploy_key"
	if err := g.CloneOrFetch(context.Background(), dir, "git@h:o/r.git", "", key, CloneOpts{}, nil); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, o := range f.opts {
		for _, e := range o.Env {
			if strings.HasPrefix(e, "GIT_SSH_COMMAND=") {
				found = true
				want := "GIT_SSH_COMMAND=ssh -i " + key +
					" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
				if e != want {
					t.Fatalf("ssh command: got %q want %q", e, want)
				}
			}
		}
	}
	if !found {
		t.Fatal("GIT_SSH_COMMAND not set")
	}
	// Empty ref falls back to HEAD.
	if !strings.Contains(joined(f.argv), "fetch --depth 1 origin HEAD") {
		t.Fatalf("default ref HEAD missing:\n%s", joined(f.argv))
	}
}

func TestCloneOrFetchOptIns(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "checkout")
	f := &fakeRunner{failAt: -1}
	g := &Git{Bin: "/usr/bin/git", runner: f}
	err := g.CloneOrFetch(
		context.Background(), dir, "git@h:o/r.git", "main", "",
		CloneOpts{Submodules: true, LFS: true}, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	j := joined(f.argv)
	if !strings.Contains(j, "submodule update --init --depth 1") {
		t.Fatalf("submodule opt-in missing:\n%s", j)
	}
	if !strings.Contains(j, "lfs pull") {
		t.Fatalf("lfs opt-in missing:\n%s", j)
	}
	// Opt-ins run after checkout so the worktree exists.
	if strings.Index(j, "submodule update") < strings.Index(j, "checkout -f") {
		t.Fatalf("submodule ran before checkout:\n%s", j)
	}
}
