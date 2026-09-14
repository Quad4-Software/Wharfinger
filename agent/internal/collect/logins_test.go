package collect

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestParseWhoLine(t *testing.T) {
	// Modern util-linux who: ISO date + time + parenthesized host.
	s, ok := parseWhoLine("alice    pts/0        2024-06-01 10:15 (10.0.0.5)")
	if !ok {
		t.Fatal("who line rejected")
	}
	if s.User != "alice" || s.TTY != "pts/0" || s.From != "10.0.0.5" {
		t.Fatalf("bad session: %+v", s)
	}
	if s.Since != "2024-06-01 10:15" {
		t.Fatalf("since = %q", s.Since)
	}

	// Local display login still parses but carries a colon source.
	s, ok = parseWhoLine("bob      tty7         2024-06-01 09:00 (:0)")
	if !ok || s.From != ":0" {
		t.Fatalf("local row misparsed: %+v", s)
	}

	// No host field at all.
	s, ok = parseWhoLine("carol    pts/1        2024-06-01 11:00")
	if !ok || s.From != "" || s.Since != "2024-06-01 11:00" {
		t.Fatalf("hostless row misparsed: %+v", s)
	}

	// Legacy three-field time keeps its formatting.
	s, ok = parseWhoLine("dave     pts/2        Jun  1 12:30 (host.example)")
	if !ok || s.Since != "Jun 1 12:30" || s.From != "host.example" {
		t.Fatalf("legacy row misparsed: %+v", s)
	}

	if _, ok := parseWhoLine(""); ok {
		t.Fatal("empty line accepted")
	}
	if _, ok := parseWhoLine("lone"); ok {
		t.Fatal("short line accepted")
	}
}

func TestParseSSHLogSyslog(t *testing.T) {
	data := `Jun  1 10:15:30 host sshd[100]: Accepted password for alice from 10.0.0.5 port 51234 ssh2
Jun  1 10:16:01 host sshd[101]: Accepted publickey for bob from 10.0.0.6 port 51235 ssh2
Jun  1 10:17:22 host sshd[102]: Failed password for invalid user admin from 203.0.113.9 port 40000 ssh2
Jun  1 10:18:03 host sshd[103]: Failed password for alice from 203.0.113.9 port 40001 ssh2
Jun  1 10:18:40 host sshd[104]: Disconnected from user alice 10.0.0.5 port 51234
Jun  1 10:19:00 host sshd[105]: Failed password for invalid user  from 198.51.100.2 port 1 ssh2
`
	evs := parseSSHLog(data, "syslog")
	if len(evs) != 4 {
		t.Fatalf("expected 4 events, got %d: %+v", len(evs), evs)
	}
	a := evs[0].ev
	if a.Kind != "accepted" || a.User != "alice" || a.Src != "10.0.0.5" || a.Method != "password" {
		t.Fatalf("accepted event misparsed: %+v", a)
	}
	if a.Ts != "Jun 1 10:15:30" {
		t.Fatalf("ts = %q", a.Ts)
	}
	if evs[1].ev.Method != "publickey" {
		t.Fatalf("method = %q", evs[1].ev.Method)
	}
	f := evs[2].ev
	if f.Kind != "failed" || f.User != "admin" || f.Src != "203.0.113.9" {
		t.Fatalf("invalid-user failure misparsed: %+v", f)
	}
	// Disconnected lines produce no event; a truncated invalid-user
	// line with an empty name still parses harmlessly.
	for _, e := range evs {
		if e.at.IsZero() {
			t.Fatalf("timestamp not parsed for %+v", e.ev)
		}
	}
}

func TestParseSSHLogJournalISO(t *testing.T) {
	data := `2024-06-01T10:15:30+0000 host sshd[100]: Accepted publickey for alice from 10.0.0.5 port 51234 ssh2
2024-06-01T10:17:22+0000 host sshd[102]: Failed password for invalid user root from 203.0.113.9 port 40000 ssh2
2024-06-01T10:18:00+0000 host CRON[9]: pam_unix(cron:session): session opened
garbage line with no match at all
`
	evs := parseSSHLog(data, "iso")
	if len(evs) != 2 {
		t.Fatalf("expected 2 events, got %d: %+v", len(evs), evs)
	}
	if evs[0].ev.Kind != "accepted" || evs[0].ev.User != "alice" || evs[0].ev.Method != "publickey" {
		t.Fatalf("iso accepted misparsed: %+v", evs[0].ev)
	}
	if evs[1].ev.Kind != "failed" || evs[1].ev.Src != "203.0.113.9" {
		t.Fatalf("iso failed misparsed: %+v", evs[1].ev)
	}
	want := time.Date(2024, 6, 1, 10, 15, 30, 0, time.UTC)
	if !evs[0].at.Equal(want) {
		t.Fatalf("iso time = %v want %v", evs[0].at, want)
	}
}

func TestSplitLogPrefix(t *testing.T) {
	if _, _, msg := splitLogPrefix("too short", "syslog"); msg != "" {
		t.Fatalf("short syslog line gave msg %q", msg)
	}
	ts, _, msg := splitLogPrefix(
		"2024-06-01T10:15:30+0000 host sshd[1]: msg body", "iso")
	if ts != "2024-06-01T10:15:30+0000" {
		t.Fatalf("iso ts = %q", ts)
	}
	if msg == "" {
		t.Fatal("iso msg empty")
	}
	if _, at, _ := splitLogPrefix("not-a-ts host sshd[1]: x", "iso"); !at.IsZero() {
		t.Fatal("unparseable iso ts should give zero time")
	}
}

func TestTailFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "auth.log")
	body := "line one\nline two\nline three\n"
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	b, err := tailFile(p, 16)
	if err != nil {
		t.Fatal(err)
	}
	// 16 bytes lands mid-line; the partial first row is dropped.
	if got := string(b); got != "line three\n" {
		t.Fatalf("tail = %q", got)
	}
	b, err = tailFile(p, 4096)
	if err != nil || string(b) != body {
		t.Fatalf("full read = %q err %v", b, err)
	}
	if _, err := tailFile(dir+"/missing", 16); err == nil {
		t.Fatal("missing file should error")
	}
}
