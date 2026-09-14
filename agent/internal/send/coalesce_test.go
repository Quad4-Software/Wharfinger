package send

import (
	"errors"
	"sync"
	"testing"

	"github.com/Quad4-Software/Wharfinger/agent/internal/collect"
)

func TestBufferDrainMax(t *testing.T) {
	b := NewBuffer()
	for i := 0; i < 10; i++ {
		b.Push(&collect.Payload{Ts: int64(i)})
	}
	got := b.DrainMax(4)
	if len(got) != 4 || got[0].Ts != 0 || got[3].Ts != 3 {
		t.Fatalf("drain max: %d items, first %d", len(got), got[0].Ts)
	}
	if b.Len() != 6 {
		t.Fatalf("remainder: %d", b.Len())
	}
	got = b.DrainMax(50)
	if len(got) != 6 || b.Len() != 0 {
		t.Fatalf("over-cap drain must take all: %d left %d", len(got), b.Len())
	}
}

func TestDropOnBusy(t *testing.T) {
	var d DropOnBusy
	started := make(chan struct{})
	release := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, _, _ = d.Run(func() (int, error) {
			close(started)
			<-release
			return 1, nil
		})
	}()
	<-started
	// While the first call runs, a second must report busy.
	_, busy, err := d.Run(func() (int, error) { return 2, nil })
	if !busy || err != nil {
		t.Fatalf("concurrent call must be busy: busy=%v err=%v", busy, err)
	}
	close(release)
	wg.Wait()
	// After it finishes the gate is free again.
	n, busy, err := d.Run(func() (int, error) { return 7, nil })
	if busy || err != nil || n != 7 {
		t.Fatalf("post-release call: n=%d busy=%v err=%v", n, busy, err)
	}
}

func TestDropOnBusyAcquireRelease(t *testing.T) {
	// The async call site in main gates posts through Acquire;
	// Release must free it for the next tick.
	var d DropOnBusy
	if !d.Acquire() {
		t.Fatal("first acquire must succeed")
	}
	if d.Acquire() {
		t.Fatal("acquire while held must fail")
	}
	d.Release()
	if !d.Acquire() {
		t.Fatal("acquire after release must succeed")
	}
	d.Release()
}

func TestDropOnBusyErrorStillReleases(t *testing.T) {
	var d DropOnBusy
	want := errors.New("post failed")
	_, busy, err := d.Run(func() (int, error) { return 0, want })
	if busy || !errors.Is(err, want) {
		t.Fatalf("error passthrough: busy=%v err=%v", busy, err)
	}
	_, busy, _ = d.Run(func() (int, error) { return 0, nil })
	if busy {
		t.Fatal("gate must release after a failed call")
	}
}
