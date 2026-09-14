package main

import (
	"math/rand/v2"
	"testing"
	"time"
)

func TestJitterBackoffBounds(t *testing.T) {
	defer func() { randFloat = rand.Float64 }()
	base := 4 * time.Second

	// Pinned extremes of the jitter factor.
	randFloat = func() float64 { return 0 }
	if got := jitterBackoff(base); got != 3*time.Second {
		t.Fatalf("floor: %s", got)
	}
	randFloat = func() float64 { return 0.999999 }
	if got := jitterBackoff(base); got >= 5*time.Second {
		t.Fatalf("ceiling: %s", got)
	}

	// The real source stays inside +/-25% over many samples.
	randFloat = rand.Float64
	for i := 0; i < 1000; i++ {
		got := jitterBackoff(base)
		if got < 3*time.Second || got > 5*time.Second {
			t.Fatalf("out of bounds: %s", got)
		}
	}
}
