package deploy

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Quad4-Software/Wharfinger/agent/internal/config"
	"github.com/Quad4-Software/Wharfinger/agent/internal/send"
)

// scriptRunner answers with canned stdout keyed on argv substrings;
// unmatched calls succeed with no output.
type scriptRunner struct {
	fakeRunner
	stdout map[string]string
}

func (s *scriptRunner) Run(ctx context.Context, argv []string, opts CmdOpts, out io.Writer) error {
	if err := s.fakeRunner.Run(ctx, argv, opts, out); err != nil {
		return err
	}
	j := strings.Join(argv, " ")
	for key, resp := range s.stdout {
		if strings.Contains(j, key) {
			if out != nil {
				_, _ = io.WriteString(out, resp)
			}
			break
		}
	}
	return nil
}

// actionHub answers every job action with ok and records the calls.
type actionHub struct {
	t       *testing.T
	actions []string
	last    map[string]any
}

func (h *actionHub) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			// The endpoint's one-time pubkey probe; not an action.
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"pub":""}`)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			h.t.Errorf("action body %s: %v", r.URL.Path, err)
		}
		if a, ok := body["action"].(string); ok {
			h.actions = append(h.actions, a)
		}
		h.last = body
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"ok":true}`)
	}
}

func testExecutor(t *testing.T, hubURL string, rt *Runtime) *Executor {
	t.Helper()
	cfg := config.Config{HubURL: hubURL, Token: "tok", Timeout: 5 * time.Second, Insecure: true}
	_, id, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	e := &Executor{
		hub:      NewClient(send.NewEndpoint(hubURL), cfg, id),
		journal:  NewJournal(t.TempDir()),
		runner:   rt.runner,
		stateDir: t.TempDir(),
		git:      NewGit(rt.runner),
		rt:       rt,
	}
	return e
}

func TestParseTeardownSpec(t *testing.T) {
	good := `{"appId":"app_abc","runtime":"k8s","namespace":"prod"}`
	s, err := ParseTeardownSpec(good)
	if err != nil {
		t.Fatal(err)
	}
	if s.AppID != "app_abc" || s.Runtime != "k8s" || s.Namespace != "prod" {
		t.Fatalf("bad spec: %+v", s)
	}
	for _, bad := range []string{
		`{"appId":"../escape"}`,
		`{"appId":"has space"}`,
		`{"appId":""}`,
		`{"appId":"app_abc","runtime":"swarm"}`,
		`{"appId":"app_abc","runtime":"k8s","namespace":"Bad NS"}`,
		`not json`,
	} {
		if _, err := ParseTeardownSpec(bad); err == nil {
			t.Fatalf("spec %s must fail", bad)
		}
	}
}

func TestExecuteTeardown(t *testing.T) {
	runner := &scriptRunner{
		fakeRunner: fakeRunner{failAt: -1},
		stdout: map[string]string{
			" ps ":    "app_x-rel1\napp_x-rel2\nxapp_x-bad\n\n",
			"images": "app_x:rel1\napp_x:rel2\nother:tag\n",
		},
	}
	rt := &Runtime{Name: "podman", Bin: "/bin/podman", runner: runner}
	hub := &actionHub{t: t}
	srv := httptest.NewServer(hub.handler())
	defer srv.Close()
	e := testExecutor(t, srv.URL, rt)

	// Seed the dirs teardown must remove: the src link and the
	// static release tree.
	srcLink := filepath.Join(e.stateDir, "src", "app_x")
	if err := os.MkdirAll(srcLink, 0o700); err != nil {
		t.Fatal(err)
	}
	staticDir := filepath.Join(e.stateDir, "static", "app_x", "rel-rel1")
	if err := os.MkdirAll(staticDir, 0o700); err != nil {
		t.Fatal(err)
	}

	job := &Job{ID: 7, Kind: "teardown", Lease: "lease-1",
		Spec: `{"appId":"app_x","runtime":"podman"}`}
	if err := e.executeTeardown(context.Background(), job); err != nil {
		t.Fatal(err)
	}

	j := joined(runner.argv)
	for _, want := range []string{
		"stop -t 10 app_x-rel1",
		"rm -f app_x-rel1",
		"rm -f app_x-rel2",
		"rmi -f app_x:rel1",
		"rmi -f app_x:rel2",
	} {
		if !strings.Contains(j, want) {
			t.Fatalf("missing %q in:\n%s", want, j)
		}
	}
	// The substring-matched non-prefix names must not be touched.
	if strings.Contains(j, "xapp_x-bad") || strings.Contains(j, "other:tag") {
		t.Fatalf("non-prefixed object acted on:\n%s", j)
	}
	if _, err := os.Lstat(srcLink); !os.IsNotExist(err) {
		t.Fatalf("src link not removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(e.stateDir, "static", "app_x")); !os.IsNotExist(err) {
		t.Fatalf("static dir not removed: %v", err)
	}
	if len(hub.actions) == 0 || hub.actions[0] != "start" || hub.actions[len(hub.actions)-1] != "succeed" {
		t.Fatalf("actions: %v", hub.actions)
	}
	res, _ := hub.last["result"].(map[string]any)
	removed, _ := res["removed"].([]any)
	if len(removed) != 4 {
		t.Fatalf("removed: %v", res)
	}
}

func TestExecuteTeardownNoRuntime(t *testing.T) {
	hub := &actionHub{t: t}
	srv := httptest.NewServer(hub.handler())
	defer srv.Close()
	runner := &scriptRunner{fakeRunner: fakeRunner{failAt: -1}}
	e := testExecutor(t, srv.URL, &Runtime{Name: "podman", Bin: "/bin/podman", runner: runner})
	e.rt = nil // static-only agent

	job := &Job{ID: 8, Kind: "teardown", Lease: "lease-2",
		Spec: `{"appId":"app_y","runtime":"podman"}`}
	if err := e.executeTeardown(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	// No runtime calls at all; the job still reports success.
	if len(runner.argv) != 0 {
		t.Fatalf("unexpected runtime calls: %s", joined(runner.argv))
	}
	if hub.actions[len(hub.actions)-1] != "succeed" {
		t.Fatalf("actions: %v", hub.actions)
	}
}
