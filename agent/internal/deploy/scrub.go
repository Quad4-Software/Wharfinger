package deploy

import (
	"bytes"
	"io"
	"strings"
)

const (
	// Values shorter than this are not tracked: single characters
	// and short tokens would redact ordinary output into noise.
	scrubMinLen = 4
	// An unbroken line is emitted once it exceeds this bound so a
	// runaway write cannot grow the pending buffer without limit.
	scrubMaxLine = 64 * 1024
)

// secretNeedles collects the env values worth tracking; shorter
// values are dropped so ordinary output stays readable.
func secretNeedles(env map[string]string) [][]byte {
	out := make([][]byte, 0, len(env))
	for _, v := range env {
		if len(v) >= scrubMinLen {
			out = append(out, []byte(v))
		}
	}
	return out
}

// scrubWriter redacts secret values from the log stream before it
// reaches the hub or the local ring. Lines are buffered so a value
// split across Write calls still matches.
type scrubWriter struct {
	w       io.Writer
	needles [][]byte
	buf     []byte
}

// Write buffers partial lines and emits scrubbed complete lines.
func (s *scrubWriter) Write(p []byte) (int, error) {
	s.buf = append(s.buf, p...)
	start := 0
	for {
		i := bytes.IndexByte(s.buf[start:], '\n')
		if i < 0 {
			break
		}
		s.emit(s.buf[start : start+i+1])
		start += i + 1
	}
	s.buf = append(s.buf[:0], s.buf[start:]...)
	if len(s.buf) > scrubMaxLine {
		s.emit(s.buf)
		s.buf = s.buf[:0]
	}
	return len(p), nil
}

func (s *scrubWriter) emit(line []byte) {
	for _, n := range s.needles {
		line = bytes.ReplaceAll(line, n, []byte("***"))
	}
	_, _ = s.w.Write(line)
}

// Flush emits any pending partial line.
func (s *scrubWriter) Flush() {
	if len(s.buf) > 0 {
		s.emit(s.buf)
		s.buf = nil
	}
}

// scrubText redacts tracked values from a string; used for output
// that reaches the report channel outside the writer path, like
// container log tails attached to a failure result.
func scrubText(s string, needles [][]byte) string {
	for _, n := range needles {
		s = strings.ReplaceAll(s, string(n), "***")
	}
	return s
}
