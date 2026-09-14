package deploy

import (
	"context"
	"sync"
	"time"
)

// progressChunk is the per-call cap on log uploads; the hub caps the
// stored log itself, so chunks stay small and frequent.
const progressChunk = 4 * 1024

// progressWriter batches step output into bounded chunks and uploads
// each with the progress action. Uploads are synchronous with the
// per-request timeout and errors are dropped: log shipping must
// never block or fail the deploy itself.
type progressWriter struct {
	hub   *Client
	jobID int64
	lease string
	ctx   context.Context

	mu  sync.Mutex
	buf []byte
}

func newProgress(ctx context.Context, hub *Client, job *Job) *progressWriter {
	return &progressWriter{hub: hub, jobID: job.ID, lease: job.Lease, ctx: ctx}
}

func (w *progressWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.buf = append(w.buf, p...)
	for len(w.buf) >= progressChunk {
		w.sendLocked(string(w.buf[:progressChunk]))
		w.buf = w.buf[progressChunk:]
	}
	return len(p), nil
}

// Note marks a step transition in the uploaded log.
func (w *progressWriter) Note(msg string) {
	_, _ = w.Write([]byte("\n==> " + msg + "\n"))
}

// Flush sends whatever is buffered; called on every step transition
// and once at the end of the job.
func (w *progressWriter) Flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.buf) == 0 {
		return
	}
	w.sendLocked(string(w.buf))
	w.buf = nil
}

func (w *progressWriter) sendLocked(chunk string) {
	_, _ = w.hub.Action(w.ctx, w.jobID, w.lease, "progress", chunk, nil)
}

// heartbeatLoop extends the job lease every interval. If the hub
// reports the lease lost it calls abort so local work stops instead
// of racing the attempt that took over.
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
				ok, err := e.hub.Action(ctx, job.ID, job.Lease, "heartbeat", "", nil)
				if err == nil && !ok {
					abort()
					return
				}
			}
		}
	}()
	return done
}
