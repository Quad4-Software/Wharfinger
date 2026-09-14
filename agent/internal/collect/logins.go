package collect

import (
	"bytes"
	"io"
	"os"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

// Logins reports interactive login activity: current sessions from
// who, recent sshd auth events from the journal or the auth log, and
// failure stats over the last 24h. Linux only; other platforms omit
// the section entirely.
type Logins struct {
	Sessions  []LoginSession  `json:"sessions,omitempty"`
	Events    []LoginEvent    `json:"events,omitempty"`
	Remote    int             `json:"remote"`
	Failed24h int             `json:"failed24h"`
	TopFailed []LoginOffender `json:"topFailed,omitempty"`
	// Partial marks the log sources unreachable (missing tools or
	// permissions); the panel can then say so instead of showing an
	// empty event list that looks like silence.
	Partial bool   `json:"partial,omitempty"`
	Note    string `json:"note,omitempty"`
}

type LoginSession struct {
	User  string `json:"user"`
	TTY   string `json:"tty"`
	From  string `json:"from,omitempty"`
	Since string `json:"since,omitempty"`
}

type LoginEvent struct {
	Ts     string `json:"ts"`
	Kind   string `json:"kind"` // accepted | failed
	User   string `json:"user"`
	Src    string `json:"src"`
	Method string `json:"method,omitempty"`
}

type LoginOffender struct {
	Src   string `json:"src"`
	Count int    `json:"count"`
}

const (
	maxLoginSessions = 20
	maxLoginEvents   = 30
	maxTopOffenders  = 5
	logTailBytes     = 64 << 10
)

// authLogCandidates covers Debian/Ubuntu and RHEL/Fedora layouts.
var authLogCandidates = []string{
	"/var/log/auth.log",
	"/var/log/secure",
}

// authLineRe bounds user and source fields so hostile or corrupt
// lines cannot smuggle huge captures through the regex.
var (
	sshAcceptedRe = regexp.MustCompile(`Accepted (\S{1,32}) for (\S{1,64}) from (\S{1,64})`)
	sshFailedRe   = regexp.MustCompile(`Failed (\S{1,32}) for (?:invalid user )?(\S{1,64}) from (\S{1,64})`)
)

func loginsMetrics() *Logins {
	if runtime.GOOS != "linux" {
		return nil
	}
	l := &Logins{}
	l.Sessions = whoSessions()
	for _, s := range l.Sessions {
		// A parenthesized X display like (:0) is local, not ssh.
		if s.From != "" && !strings.HasPrefix(s.From, ":") {
			l.Remote++
		}
	}

	events, journalOK := journalEvents()
	if len(events) == 0 {
		fileEv, logOK, permDenied := authLogEvents()
		if len(fileEv) > 0 {
			events = fileEv
			journalOK = true
		} else if !journalOK && !logOK {
			l.Partial = true
			if permDenied {
				l.Note = "ssh auth log unreadable; run the agent as root or in the adm group"
			} else {
				l.Note = "no ssh log source (journalctl, auth.log, secure)"
			}
		}
	}

	now := time.Now()
	offenders := map[string]int{}
	// Newest first: sources emit chronological order, so walk back.
	for i := len(events) - 1; i >= 0 && len(l.Events) < maxLoginEvents; i-- {
		l.Events = append(l.Events, events[i].ev)
	}
	for _, e := range events {
		if e.ev.Kind != "failed" || e.at.IsZero() {
			continue
		}
		if now.Sub(e.at) <= 24*time.Hour {
			l.Failed24h++
			offenders[e.ev.Src]++
		}
	}
	for src, n := range offenders {
		l.TopFailed = append(l.TopFailed, LoginOffender{Src: src, Count: n})
	}
	sort.Slice(l.TopFailed, func(a, b int) bool {
		if l.TopFailed[a].Count != l.TopFailed[b].Count {
			return l.TopFailed[a].Count > l.TopFailed[b].Count
		}
		return l.TopFailed[a].Src < l.TopFailed[b].Src
	})
	if len(l.TopFailed) > maxTopOffenders {
		l.TopFailed = l.TopFailed[:maxTopOffenders]
	}
	return l
}

// parseWhoLine reads one who row: "user pts/0 2024-06-01 10:15
// (10.0.0.5)". The login time keeps its source formatting; newer
// util-linux emits ISO date+time (two fields) while older builds can
// emit a three-field "Jun 1 10:15", so everything between the tty and
// the parenthesized host is kept verbatim.
func parseWhoLine(line string) (LoginSession, bool) {
	f := strings.Fields(line)
	if len(f) < 3 {
		return LoginSession{}, false
	}
	s := LoginSession{User: f[0], TTY: f[1]}
	rest := f[2:]
	if i := strings.Index(line, "("); i >= 0 {
		if j := strings.LastIndex(line, ")"); j > i {
			s.From = line[i+1 : j]
		}
		// Drop the trailing "(host)" field from the time fields when
		// it was a single token; who never puts spaces inside it.
		if n := len(rest); n > 0 && strings.HasPrefix(rest[n-1], "(") {
			rest = rest[:n-1]
		}
	}
	s.Since = strings.Join(rest, " ")
	return s, true
}

func whoSessions() []LoginSession {
	b, err := runCmd(3*time.Second, "who")
	if err != nil {
		return nil
	}
	var out []LoginSession
	for _, line := range strings.Split(string(b), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if s, ok := parseWhoLine(line); ok {
			out = append(out, s)
		}
		if len(out) >= maxLoginSessions {
			break
		}
	}
	return out
}

// timedEvent pairs a parsed event with its timestamp for the 24h
// failure window; the display string stays as the source wrote it.
type timedEvent struct {
	ev LoginEvent
	at time.Time
}

func journalEvents() ([]timedEvent, bool) {
	b, err := runCmd(4*time.Second, "journalctl",
		"-u", "ssh", "-u", "sshd", "-n", "100", "--no-pager", "-o", "short-iso")
	if err != nil {
		return nil, false
	}
	return parseSSHLog(string(b), "iso"), true
}

// authLogEvents tails the first readable auth log. Returns the events,
// whether any candidate was readable, and whether a candidate existed
// but was denied by permissions.
func authLogEvents() (events []timedEvent, readable bool, permDenied bool) {
	for _, p := range authLogCandidates {
		b, err := tailFile(p, logTailBytes)
		if err != nil {
			if os.IsPermission(err) {
				permDenied = true
			}
			continue
		}
		readable = true
		events = append(events, parseSSHLog(string(b), "syslog")...)
	}
	return events, readable, permDenied
}

// tailFile reads at most the last n bytes of path, dropping the
// partial first line so a mid-line seek never yields a corrupt row.
func tailFile(path string, n int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	off := int64(0)
	if st.Size() > n {
		off = st.Size() - n
	}
	if _, err := f.Seek(off, io.SeekStart); err != nil {
		return nil, err
	}
	b, err := io.ReadAll(io.LimitReader(f, n))
	if err != nil {
		return nil, err
	}
	if off > 0 {
		if i := bytes.IndexByte(b, '\n'); i >= 0 {
			b = b[i+1:]
		} else {
			b = b[:0]
		}
	}
	return b, nil
}

// parseSSHLog extracts accepted/failed auth events. format picks the
// timestamp style: "iso" for journalctl -o short-iso prefixes, "syslog"
// for the classic "Jan  2 15:04:05 host" auth.log prefix. Disconnected
// and other sshd noise lines produce no event.
func parseSSHLog(data, format string) []timedEvent {
	var out []timedEvent
	for _, line := range strings.Split(data, "\n") {
		ts, at, msg := splitLogPrefix(line, format)
		if msg == "" {
			continue
		}
		if m := sshAcceptedRe.FindStringSubmatch(msg); m != nil {
			out = append(out, timedEvent{
				ev: LoginEvent{Ts: ts, Kind: "accepted", User: m[2], Src: m[3], Method: m[1]},
				at: at,
			})
			continue
		}
		if m := sshFailedRe.FindStringSubmatch(msg); m != nil {
			out = append(out, timedEvent{
				ev: LoginEvent{Ts: ts, Kind: "failed", User: m[2], Src: m[3], Method: m[1]},
				at: at,
			})
		}
	}
	return out
}

// splitLogPrefix separates the timestamp prefix from the message.
// The display string is kept exactly as logged; the returned time is
// best-effort for the 24h window and zero when unparseable.
func splitLogPrefix(line, format string) (ts string, at time.Time, msg string) {
	switch format {
	case "iso":
		// journalctl short-iso: "2024-06-01T10:15:30+0000 host sshd[..]: msg"
		f := strings.Fields(line)
		if len(f) < 2 {
			return "", time.Time{}, ""
		}
		for _, layout := range []string{
			"2006-01-02T15:04:05-0700",
			"2006-01-02T15:04:05Z0700",
			time.RFC3339,
		} {
			if t, err := time.Parse(layout, f[0]); err == nil {
				at = t
				break
			}
		}
		// f[0] need not sit at offset 0 if the line was indented.
		i := strings.Index(line, f[0])
		return f[0], at, strings.TrimSpace(line[i+len(f[0]):])
	case "syslog":
		// auth.log: "Jan  2 15:04:05 host sshd[..]: msg" (15-char ts)
		f := strings.Fields(line)
		if len(f) < 4 {
			return "", time.Time{}, ""
		}
		ts = strings.Join(f[:3], " ")
		// Syslog stamps carry no year; assume the current one and
		// roll back a year if that lands in the future.
		if t, err := time.ParseInLocation("Jan 2 15:04:05", ts, time.Local); err == nil {
			at = t.AddDate(time.Now().Year(), 0, 0)
			if at.After(time.Now().Add(24 * time.Hour)) {
				at = at.AddDate(-1, 0, 0)
			}
		}
		return ts, at, strings.Join(f[3:], " ")
	}
	return "", time.Time{}, ""
}
