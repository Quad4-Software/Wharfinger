// Package scan runs trivy against the image a claimed scan job
// names and reports the compact finding list back to the hub job
// lifecycle endpoints. One job at a time: the caller serializes
// Execute calls, same as the deploy executor.
package scan

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"os/exec"
	"time"

	"github.com/Quad4-Software/Wharfinger/agent/internal/config"
	"github.com/Quad4-Software/Wharfinger/agent/internal/send"
)

const (
	// scanTimeout bounds the trivy run including first-pull image
	// fetch time.
	scanTimeout = 10 * time.Minute
	// heartbeatEvery keeps the hub lease alive during long scans;
	// the hub lease itself is 120s.
	heartbeatEvery = 30 * time.Second
	// maxReportBytes bounds trivy's stdout in memory. JSON output
	// for a large image is a few MB; anything beyond is hostile or
	// broken and fails the job rather than the agent.
	maxReportBytes = 32 << 20
	// wireFindings caps the findings posted inside the job result so
	// the payload stays under the hub's 256KB result limit. The hub
	// stores up to its own per-report cap.
	wireFindings = 300
	// failTailCap bounds the stderr tail attached to a fail report.
	failTailCap = 2 * 1024
)

// Job is one claimed scan job from the hub queue. Spec is a frozen
// JSON string parsed by ParseSpec.
type Job struct {
	ID         int64  `json:"id"`
	Kind       string `json:"kind"`
	Spec       string `json:"spec"`
	Lease      string `json:"lease"`
	LeaseUntil int64  `json:"leaseUntil"`
	Attempt    int    `json:"attempt"`
}

// Client posts claim and lifecycle calls to the hub. Bodies go
// through send.PostSigned so the bearer token and the ed25519 proof
// headers cover the exact request bytes, same as metrics posts.
type Client struct {
	ep  *send.Endpoint
	cfg config.Config
	id  ed25519.PrivateKey
}

func NewClient(ep *send.Endpoint, cfg config.Config, id ed25519.PrivateKey) *Client {
	return &Client{ep: ep, cfg: cfg, id: id}
}

func (c *Client) post(ctx context.Context, path string, body any) ([]byte, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, c.cfg.Timeout)
	defer cancel()
	return send.PostSigned(cctx, c.ep, c.cfg, c.id, path, raw)
}

// Claim asks the hub for the next scan job. A nil job means the
// queue is empty for this agent.
func (c *Client) Claim(ctx context.Context) (*Job, error) {
	res, err := c.post(ctx, "/ingress/jobs/claim", map[string]any{
		"kinds": []string{"scan"},
	})
	if err != nil {
		return nil, err
	}
	var out struct {
		Job *Job `json:"job"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		return nil, fmt.Errorf("claim: bad response: %w", err)
	}
	return out.Job, nil
}

// Action posts one lifecycle transition for a job. It returns false
// when the hub rejected the lease: another attempt owns the job now,
// and continuing locally could race it.
func (c *Client) Action(ctx context.Context, jobID int64, lease, action string, result any) (bool, error) {
	body := map[string]any{"lease": lease, "action": action}
	if result != nil {
		body["result"] = result
	}
	res, err := c.post(ctx, fmt.Sprintf("/ingress/jobs/%d", jobID), body)
	if err != nil {
		return false, err
	}
	var out struct {
		Ok     bool   `json:"ok"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		return false, fmt.Errorf("job action: bad response: %w", err)
	}
	return out.Ok || out.Status != "", nil
}

// runFunc executes a fixed argv and returns bounded stdout. It is a
// field so tests can stub trivy; implementations never invoke a
// shell.
type runFunc func(ctx context.Context, argv []string) ([]byte, error)

// Executor runs claimed scan jobs against the local trivy install.
type Executor struct {
	hub      *Client
	lookPath func(file string) (string, error)
	run      runFunc
}

// NewExecutor returns an executor that resolves trivy from PATH per
// job, so installing it later needs no agent restart.
func NewExecutor(hub *Client) *Executor {
	return &Executor{hub: hub, lookPath: exec.LookPath, run: execOutput}
}

// Claim asks the hub for the next scan job; nil means none queued.
func (e *Executor) Claim(ctx context.Context) (*Job, error) {
	return e.hub.Claim(ctx)
}

// Execute runs one claimed job to a terminal report. Failures post a
// fail action with a bounded message; the job never returns an error
// for scan problems, only for hub communication failures.
func (e *Executor) Execute(ctx context.Context, job *Job) error {
	spec, err := ParseSpec(job.Spec)
	if err != nil {
		return e.fail(ctx, job, fmt.Sprintf("bad spec: %v", err))
	}
	bin, err := e.lookPath("trivy")
	if err != nil {
		return e.fail(ctx, job, "trivy not installed, run wharfinger-agent setup")
	}

	if _, err := e.hub.Action(ctx, job.ID, job.Lease, "start", nil); err != nil {
		return err
	}

	jctx, cancel := context.WithTimeout(ctx, scanTimeout)
	defer cancel()
	done := e.heartbeatLoop(jctx, job, cancel)
	defer close(done)

	argv := []string{bin, "image", "--format", "json",
		"--severity", "CRITICAL,HIGH,MEDIUM,LOW", "--quiet", spec.ImageRef}
	out, err := e.run(jctx, argv)
	if err != nil {
		return e.fail(ctx, job, err.Error())
	}
	res, err := ParseReport(out, spec.ScanID, wireFindings)
	if err != nil {
		return e.fail(ctx, job, fmt.Sprintf("trivy output: %v", err))
	}
	ok, err := e.hub.Action(ctx, job.ID, job.Lease, "succeed", res)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("job %d: lease lost, result rejected", job.ID)
	}
	return nil
}

func (e *Executor) fail(ctx context.Context, job *Job, msg string) error {
	if len(msg) > failTailCap {
		msg = msg[len(msg)-failTailCap:]
	}
	_, err := e.hub.Action(ctx, job.ID, job.Lease, "fail", map[string]any{
		"error": msg,
	})
	return err
}

// heartbeatLoop extends the job lease every interval. If the hub
// reports the lease lost it calls abort so the trivy run stops
// instead of racing the attempt that took over.
func (e *Executor) heartbeatLoop(ctx context.Context, job *Job, abort context.CancelFunc) chan<- struct{} {
	done := make(chan struct{})
	go func() {
		t := time.NewTicker(heartbeatEvery)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-t.C:
				ok, err := e.hub.Action(ctx, job.ID, job.Lease, "heartbeat", nil)
				if err == nil && !ok {
					abort()
					return
				}
			}
		}
	}()
	return done
}

// execOutput runs argv with bounded stdout and a small stderr tail.
// argv is fixed by the caller; no shell is involved.
func execOutput(ctx context.Context, argv []string) ([]byte, error) {
	if len(argv) == 0 || argv[0] == "" {
		return nil, fmt.Errorf("empty argv")
	}
	c := exec.CommandContext(ctx, argv[0], argv[1:]...)
	out := &capped{max: maxReportBytes}
	errTail := &capped{max: failTailCap}
	c.Stdout = out
	c.Stderr = errTail
	err := c.Run()
	if ctx.Err() != nil {
		return nil, fmt.Errorf("%s: %w", argv[0], ctx.Err())
	}
	if err != nil {
		msg := err.Error()
		if tail := string(errTail.buf); tail != "" {
			msg = fmt.Sprintf("%s: %s", msg, tail)
		}
		return nil, fmt.Errorf("%s: %s", argv[0], msg)
	}
	return out.buf, nil
}

// capped is an io.Writer that keeps the first max bytes; overflow is
// an error so a runaway report cannot grow without bound.
type capped struct {
	buf []byte
	max int
}

func (c *capped) Write(p []byte) (int, error) {
	if len(c.buf)+len(p) > c.max {
		room := c.max - len(c.buf)
		if room > 0 {
			c.buf = append(c.buf, p[:room]...)
		}
		return 0, fmt.Errorf("output exceeds %d bytes", c.max)
	}
	c.buf = append(c.buf, p...)
	return len(p), nil
}
