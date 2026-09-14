package deploy

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// gitTimeout bounds a full shallow fetch; repos are depth-1 so this
// is generous.
const gitTimeout = 5 * time.Minute

// Git wraps the system git binary for shallow checkouts.
type Git struct {
	Bin    string
	runner CmdRunner
}

func NewGit(r CmdRunner) *Git {
	return &Git{Bin: resolveBin("git"), runner: r}
}

// gitEnv disables interactive prompts (a blocked password prompt
// would hang the job until timeout) and wires the deploy key through
// GIT_SSH_COMMAND when the spec carries one. The key path was
// already validated to live under the state dir and contain no
// whitespace, so embedding it in the env string is safe.
func gitEnv(keyFile string) []string {
	env := []string{"GIT_TERMINAL_PROMPT=0"}
	if keyFile != "" {
		env = append(env, "GIT_SSH_COMMAND=ssh -i "+keyFile+
			" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new")
	}
	return env
}

// CloneOrFetch keeps a per-app checkout under the state dir and
// moves it to the requested ref with a depth-1 fetch. History is
// never kept: a deploy needs the tree at ref, nothing more. All
// argv is fixed; url and ref travel as arguments, never through a
// shell.
func (g *Git) CloneOrFetch(ctx context.Context, dir, url, ref, keyFile string, out io.Writer) error {
	if ref == "" {
		ref = "HEAD"
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	opts := CmdOpts{Dir: dir, Env: gitEnv(keyFile)}
	run := func(args ...string) error {
		return g.runner.Run(ctx, append([]string{g.Bin}, args...), opts, out)
	}
	if err := run("init"); err != nil {
		return fmt.Errorf("git init: %w", err)
	}
	// remote add fails on a reused checkout; set-url is the retry so
	// both fresh and resumed dirs converge on the spec url.
	if err := run("remote", "add", "origin", url); err != nil {
		if err := run("remote", "set-url", "origin", url); err != nil {
			return fmt.Errorf("git remote: %w", err)
		}
	}
	if err := run("fetch", "--depth", "1", "origin", ref); err != nil {
		return fmt.Errorf("git fetch: %w", err)
	}
	if err := run("checkout", "-f", "FETCH_HEAD"); err != nil {
		return fmt.Errorf("git checkout: %w", err)
	}
	return nil
}

// RevParse resolves a ref (HEAD right after a fetch/checkout) to its
// commit sha for the release record.
func (g *Git) RevParse(ctx context.Context, dir, ref string) (string, error) {
	var buf bytes.Buffer
	ctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	err := g.runner.Run(ctx, []string{g.Bin, "rev-parse", "--verify", ref}, CmdOpts{Dir: dir}, &buf)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(buf.String()), nil
}
