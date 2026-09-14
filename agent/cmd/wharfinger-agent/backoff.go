package main

import (
	"errors"
	"math/rand/v2"
	"time"
)

// backfillMaxPerTick caps how many buffered payloads flush per
// collection tick after a hub outage; the rest stay queued for later
// ticks so recovery traffic is spread out.
const backfillMaxPerTick = 50

// errPostBusy reports a metrics post skipped because the previous
// REST post is still in flight; the caller buffers the payload.
var errPostBusy = errors.New("rest post already in flight")

// randFloat is a var so tests can pin the jitter source.
var randFloat = rand.Float64

// jitterBackoff applies +/-25% jitter to a reconnect delay so a
// fleet of agents recovering from a hub outage does not redial in
// lockstep.
func jitterBackoff(base time.Duration) time.Duration {
	return time.Duration(float64(base) * (0.75 + 0.5*randFloat()))
}
