package send

import (
	"testing"

	"github.com/Quad4-Software/Wharfinger/agent/internal/collect"
)

func TestBufferBoundAndOrder(t *testing.T) {
	b := NewBuffer()
	for i := 0; i < BufferCap+50; i++ {
		b.Push(&collect.Payload{Ts: int64(i)})
	}
	if b.Len() != BufferCap {
		t.Fatalf("buffer over cap: %d", b.Len())
	}
	got := b.Drain()
	if len(got) != BufferCap {
		t.Fatalf("drain len: %d", len(got))
	}
	// Oldest 50 were evicted; first drained entry is ts=50.
	if got[0].Ts != 50 {
		t.Fatalf("oldest kept: %d", got[0].Ts)
	}
	if got[len(got)-1].Ts != int64(BufferCap+49) {
		t.Fatalf("newest kept: %d", got[len(got)-1].Ts)
	}
	if b.Len() != 0 {
		t.Fatal("drain did not clear the buffer")
	}
}

func TestBufferPushAllPreservesOrder(t *testing.T) {
	b := NewBuffer()
	b.PushAll([]*collect.Payload{{Ts: 1}, {Ts: 2}, {Ts: 3}})
	got := b.Drain()
	for i, p := range got {
		if p.Ts != int64(i+1) {
			t.Fatalf("order broken at %d: %d", i, p.Ts)
		}
	}
}
