package deploy

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
)

// CmdOpts carries per-command context that is not part of argv.
type CmdOpts struct {
	// Dir is the working directory; empty keeps the caller's.
	Dir string
	// Env entries are appended over the process environment.
	Env []string
	// In feeds the command's stdin; nil leaves stdin closed. kubectl
	// apply takes the manifest over stdin so it never touches disk.
	In io.Reader
}

// CmdRunner executes a fixed argv and streams combined stdout/stderr
// to out. It exists so tests can capture argv without a real runtime
// or git binary; implementations must never invoke a shell.
type CmdRunner interface {
	Run(ctx context.Context, argv []string, opts CmdOpts, out io.Writer) error
}

// ExecRunner is the production CmdRunner. argv[0] is expected to be
// an absolute path from resolveBin so PATH poisoning cannot steer it.
type ExecRunner struct{}

func (ExecRunner) Run(ctx context.Context, argv []string, opts CmdOpts, out io.Writer) error {
	if len(argv) == 0 || argv[0] == "" {
		return fmt.Errorf("empty argv")
	}
	if out == nil {
		out = io.Discard
	}
	c := exec.CommandContext(ctx, argv[0], argv[1:]...)
	c.Dir = opts.Dir
	if len(opts.Env) > 0 {
		c.Env = append(os.Environ(), opts.Env...)
	}
	if opts.In != nil {
		c.Stdin = opts.In
	}
	c.Stdout = out
	c.Stderr = out
	err := c.Run()
	if ctx.Err() != nil {
		return fmt.Errorf("%s: %w", argv[0], ctx.Err())
	}
	if err != nil {
		return fmt.Errorf("%s: %w", argv[0], err)
	}
	return nil
}

// ringBuf is an io.Writer that keeps only the last max bytes. Build
// and run output is unbounded; error reports and log tails only ever
// need the end of it.
type ringBuf struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func newRingBuf(max int) *ringBuf { return &ringBuf{max: max} }

func (r *ringBuf) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.max <= 0 {
		return len(p), nil
	}
	if len(p) >= r.max {
		r.buf = append(r.buf[:0], p[len(p)-r.max:]...)
		return len(p), nil
	}
	r.buf = append(r.buf, p...)
	if len(r.buf) > r.max {
		r.buf = append(r.buf[:0], r.buf[len(r.buf)-r.max:]...)
	}
	return len(p), nil
}

func (r *ringBuf) String() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return string(r.buf)
}

// tail returns at most the last n bytes of s.
func tail(s string, n int) string {
	if len(s) > n {
		s = s[len(s)-n:]
	}
	return s
}
