package scan

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Quad4-Software/Wharfinger/agent/internal/config"
	"github.com/Quad4-Software/Wharfinger/agent/internal/send"
)

type postedCall struct {
	Action string
	Body   map[string]any
}

// fakeHub records job lifecycle posts and answers ok.
func fakeHub(t *testing.T, calls *[]postedCall) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		var parsed map[string]any
		_ = json.Unmarshal(body, &parsed)
		if r.Method == http.MethodPost {
			*calls = append(*calls, postedCall{Action: fmt.Sprint(parsed["action"]), Body: parsed})
		}
		w.Header().Set("content-type", "application/json")
		if parsed["action"] == "fail" {
			_, _ = w.Write([]byte(`{"status":"failed"}`))
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
}

func testExecutor(t *testing.T, srv *httptest.Server, run runFunc, lookErr error) *Executor {
	t.Helper()
	cfg := config.Config{HubURL: srv.URL, Token: "tok", Timeout: 5 * time.Second}
	hub := NewClient(send.NewEndpoint(srv.URL), cfg, nil)
	ex := NewExecutor(hub)
	ex.run = run
	if lookErr != nil {
		ex.lookPath = func(string) (string, error) { return "", lookErr }
	} else {
		ex.lookPath = func(string) (string, error) { return "/usr/bin/trivy", nil }
	}
	return ex
}

const jobSpec = `{"scanId":"scan_abc123","appId":"app_xyz","imageRef":"registry.io/app:1.2"}`

func TestExecuteRunsFixedArgvAndPostsResult(t *testing.T) {
	var calls []postedCall
	srv := fakeHub(t, &calls)
	defer srv.Close()

	var gotArgv []string
	ex := testExecutor(t, srv, func(ctx context.Context, argv []string) ([]byte, error) {
		gotArgv = append([]string(nil), argv...)
		return []byte(fixture), nil
	}, nil)

	job := &Job{ID: 7, Kind: "scan", Spec: jobSpec, Lease: "lease-1"}
	if err := ex.Execute(context.Background(), job); err != nil {
		t.Fatal(err)
	}

	want := []string{"/usr/bin/trivy", "image", "--format", "json",
		"--severity", "CRITICAL,HIGH,MEDIUM,LOW", "--quiet", "registry.io/app:1.2"}
	if len(gotArgv) != len(want) {
		t.Fatalf("argv: %v", gotArgv)
	}
	for i, w := range want {
		if gotArgv[i] != w {
			t.Fatalf("argv[%d]: got %q want %q (full %v)", i, gotArgv[i], w, gotArgv)
		}
	}

	if len(calls) < 2 {
		t.Fatalf("expected start+succeed posts, got %d", len(calls))
	}
	if calls[0].Action != "start" || calls[0].Body["lease"] != "lease-1" {
		t.Fatalf("first call: %+v", calls[0])
	}
	last := calls[len(calls)-1]
	if last.Action != "succeed" {
		t.Fatalf("last call: %+v", last)
	}
	res, _ := last.Body["result"].(map[string]any)
	if res["scanId"] != "scan_abc123" {
		t.Fatalf("result scanId: %v", res["scanId"])
	}
	sum, _ := res["summary"].(map[string]any)
	if sum["critical"] != float64(1) {
		t.Fatalf("summary: %v", sum)
	}
	if f, _ := res["findings"].([]any); len(f) != 3 {
		t.Fatalf("findings: %v", res["findings"])
	}
}

func TestExecuteFailsWhenTrivyMissing(t *testing.T) {
	var calls []postedCall
	srv := fakeHub(t, &calls)
	defer srv.Close()

	ex := testExecutor(t, srv, func(ctx context.Context, argv []string) ([]byte, error) {
		t.Fatal("run must not be called without trivy")
		return nil, nil
	}, errors.New("not found"))

	job := &Job{ID: 8, Kind: "scan", Spec: jobSpec, Lease: "lease-1"}
	if err := ex.Execute(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 || calls[0].Action != "fail" {
		t.Fatalf("calls: %+v", calls)
	}
	res, _ := calls[0].Body["result"].(map[string]any)
	if msg := fmt.Sprint(res["error"]); !strings.Contains(msg, "trivy not installed") {
		t.Fatalf("fail message: %q", msg)
	}
}

func TestExecuteFailsOnScanError(t *testing.T) {
	var calls []postedCall
	srv := fakeHub(t, &calls)
	defer srv.Close()

	ex := testExecutor(t, srv, func(ctx context.Context, argv []string) ([]byte, error) {
		return nil, fmt.Errorf("trivy: exit status 1: image not found")
	}, nil)

	job := &Job{ID: 9, Kind: "scan", Spec: jobSpec, Lease: "lease-1"}
	if err := ex.Execute(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	last := calls[len(calls)-1]
	if last.Action != "fail" {
		t.Fatalf("last call: %+v", last)
	}
	res, _ := last.Body["result"].(map[string]any)
	if msg := fmt.Sprint(res["error"]); !strings.Contains(msg, "image not found") {
		t.Fatalf("fail message: %q", msg)
	}
}

func TestExecuteBadSpecFailsJob(t *testing.T) {
	var calls []postedCall
	srv := fakeHub(t, &calls)
	defer srv.Close()
	ex := testExecutor(t, srv, func(ctx context.Context, argv []string) ([]byte, error) {
		t.Fatal("run must not be called on a bad spec")
		return nil, nil
	}, nil)
	job := &Job{ID: 10, Kind: "scan", Spec: `{"scanId":""}`, Lease: "l"}
	if err := ex.Execute(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 || calls[0].Action != "fail" {
		t.Fatalf("calls: %+v", calls)
	}
}
