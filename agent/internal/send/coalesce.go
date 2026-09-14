package send

import "sync/atomic"

// DropOnBusy serializes a call site so a second invocation while one
// is in flight reports busy instead of running concurrently. Used
// for REST metrics posts: a slow hub must not stack overlapping
// posts, the sample is buffered and retried next tick instead.
type DropOnBusy struct {
	busy atomic.Bool
}

// Acquire takes the gate for an async call; false means a call is
// already in flight. The caller must Release when the work ends.
func (d *DropOnBusy) Acquire() bool {
	return d.busy.CompareAndSwap(false, true)
}

// Release frees the gate after an Acquire.
func (d *DropOnBusy) Release() {
	d.busy.Store(false)
}

// Run executes fn unless a previous call is still in flight. busy
// reports the call was skipped; fn is then never run.
func (d *DropOnBusy) Run(fn func() (int, error)) (pending int, busy bool, err error) {
	if !d.Acquire() {
		return 0, true, nil
	}
	defer d.Release()
	pending, err = fn()
	return pending, false, err
}
