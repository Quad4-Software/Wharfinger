package deploy

import (
	"bytes"
	"strings"
	"testing"
)

func TestScrubRedactsAcrossWriteBoundaries(t *testing.T) {
	var buf bytes.Buffer
	s := &scrubWriter{w: &buf, needles: [][]byte{[]byte("s3cr3t-value")}}
	// The secret is split across two Write calls.
	_, _ = s.Write([]byte("line one s3cr"))
	_, _ = s.Write([]byte("3t-value rest\nnext line\n"))
	s.Flush()
	got := buf.String()
	if strings.Contains(got, "s3cr3t-value") {
		t.Fatalf("secret survived scrub: %q", got)
	}
	if !strings.Contains(got, "***") {
		t.Fatalf("expected redaction marker: %q", got)
	}
}

func TestSecretNeedlesDropsShortValues(t *testing.T) {
	got := secretNeedles(map[string]string{"SHORT": "ab", "LONG": "abcd1234"})
	if len(got) != 1 || string(got[0]) != "abcd1234" {
		t.Fatalf("expected only the long value tracked: %q", got)
	}
}

func TestScrubTextRedactsInline(t *testing.T) {
	got := scrubText("token=s3cr3t-value ok", [][]byte{[]byte("s3cr3t-value")})
	if got != "token=*** ok" {
		t.Fatalf("unexpected: %q", got)
	}
}
