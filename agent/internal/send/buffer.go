package send

import (
	"sync"

	"github.com/Quad4-Software/Wharfinger/agent/internal/collect"
)

// BufferCap bounds the store-and-forward queue. At the default 10s
// interval 256 samples cover roughly 40 minutes of hub downtime;
// payloads can carry large port/service lists so the cap also keeps
// worst-case memory near ~25MB.
const BufferCap = 256

// Buffer is a bounded in-memory ring of payloads that failed delivery.
// When the hub is unreachable samples queue here instead of being
// lost; on recovery they flush oldest-first as backfill. The queue is
// intentionally memory-only: a restart drops the backlog, which is
// acceptable for metrics (the hub retains its own history).
type Buffer struct {
	mu sync.Mutex
	q  []*collect.Payload
}

func NewBuffer() *Buffer {
	return &Buffer{}
}

// Push appends a payload, dropping the oldest entry when full.
func (b *Buffer) Push(p *collect.Payload) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.q) >= BufferCap {
		b.q = b.q[1:]
	}
	b.q = append(b.q, p)
}

// PushAll requeues a partially flushed backlog preserving order.
func (b *Buffer) PushAll(ps []*collect.Payload) {
	for _, p := range ps {
		b.Push(p)
	}
}

// Drain returns queued payloads oldest-first and clears the buffer.
func (b *Buffer) Drain() []*collect.Payload {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := b.q
	b.q = nil
	return out
}

// DrainMax returns at most n queued payloads oldest-first and keeps
// the rest queued. Bounding the per-cycle drain spreads recovery
// traffic across ticks instead of bursting the whole backlog at once.
func (b *Buffer) DrainMax(n int) []*collect.Payload {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.q) <= n {
		out := b.q
		b.q = nil
		return out
	}
	out := append([]*collect.Payload(nil), b.q[:n]...)
	b.q = b.q[n:]
	return out
}

func (b *Buffer) Len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.q)
}
