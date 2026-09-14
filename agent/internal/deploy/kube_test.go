package deploy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const k8sSpec = `{
	"appId": "blog",
	"releaseId": "r42",
	"jobKey": "k1",
	"runtime": "k8s",
	"namespace": "apps-prod",
	"source": {"kind": "image", "url": "ghcr.io/o/blog:2"},
	"build": {"kind": "image"},
	"run": {
		"replicas": 3,
		"ports": [{"host": 8080, "container": 80}],
		"healthcheck": {"kind": "http", "port": 8080, "path": "/health", "intervalMs": 2000, "timeoutMs": 60000, "retries": 5}
	},
	"prevRelease": {"id": "r41", "container": "blog-r41"}
}`

func mustSpec(t *testing.T, raw string) *Spec {
	t.Helper()
	s, err := ParseSpec(raw)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestDNS1123(t *testing.T) {
	cases := map[string]string{
		"blog-r42":              "blog-r42",
		"My_App-R1":             "my-app-r1",
		"a.b_c":                 "a-b-c",
		"--lead--":              "lead",
		strings.Repeat("x", 80): strings.Repeat("x", 63),
	}
	for in, want := range cases {
		if got := dns1123(in); got != want {
			t.Fatalf("dns1123(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestKubeNames(t *testing.T) {
	s := mustSpec(t, k8sSpec)
	if got := s.kubeDeployName(); got != "blog-r42" {
		t.Fatalf("deploy name: %s", got)
	}
	if got := s.kubeNamespace(); got != "apps-prod" {
		t.Fatalf("namespace: %s", got)
	}
	if got := s.kubeReplicas(); got != 3 {
		t.Fatalf("replicas: %d", got)
	}
	s2 := mustSpec(t, `{"appId":"a","releaseId":"r1","runtime":"k8s","source":{"kind":"image","url":"x:1"},"build":{"kind":"image"},"run":{}}`)
	if got := s2.kubeNamespace(); got != "default" {
		t.Fatalf("default namespace: %s", got)
	}
	if got := s2.kubeReplicas(); got != 1 {
		t.Fatalf("default replicas: %d", got)
	}
}

func TestKubeSpecValidation(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"bad runtime", `{"appId":"a","releaseId":"r1","runtime":"nomad","source":{"kind":"static"},"build":{"kind":"static"},"run":{"image":"x:1"}}`, "runtime"},
		{"bad ns uppercase", `{"appId":"a","releaseId":"r1","namespace":"Prod","source":{"kind":"static"},"build":{"kind":"static"},"run":{"image":"x:1"}}`, "namespace"},
		{"bad ns dot", `{"appId":"a","releaseId":"r1","namespace":"a.b","source":{"kind":"static"},"build":{"kind":"static"},"run":{"image":"x:1"}}`, "namespace"},
		{"ns ok", `{"appId":"a","releaseId":"r1","runtime":"k8s","namespace":"prod-2","source":{"kind":"image","url":"x:1"},"build":{"kind":"image"},"run":{}}`, ""},
		{"replicas over", `{"appId":"a","releaseId":"r1","runtime":"k8s","source":{"kind":"image","url":"x:1"},"build":{"kind":"image"},"run":{"replicas":11}}`, "replicas"},
		{"replicas neg", `{"appId":"a","releaseId":"r1","runtime":"k8s","source":{"kind":"image","url":"x:1"},"build":{"kind":"image"},"run":{"replicas":-1}}`, "replicas"},
	}
	for _, c := range cases {
		_, err := ParseSpec(c.raw)
		if c.want == "" {
			if err != nil {
				t.Fatalf("%s: unexpected error %v", c.name, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Fatalf("%s: want error containing %q, got %v", c.name, c.want, err)
		}
	}
}

// listDoc decodes a rendered apply doc into items by kind.
func listDoc(t *testing.T, doc []byte) map[string]map[string]any {
	t.Helper()
	var l struct {
		Kind  string           `json:"kind"`
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(doc, &l); err != nil {
		t.Fatalf("apply doc is not valid json: %v", err)
	}
	if l.Kind != "List" {
		t.Fatalf("doc kind: %s", l.Kind)
	}
	out := map[string]map[string]any{}
	for _, it := range l.Items {
		out[it["kind"].(string)] = it
	}
	return out
}

func TestKubeApplyDoc(t *testing.T) {
	s := mustSpec(t, k8sSpec)
	doc, err := kubeApplyDoc(s, map[string]string{"B_KEY": "2", "A_KEY": "1"})
	if err != nil {
		t.Fatal(err)
	}
	items := listDoc(t, doc)

	if _, ok := items["Namespace"]; !ok {
		t.Fatal("pinned namespace must emit a Namespace object")
	}
	if items["Namespace"]["metadata"].(map[string]any)["name"] != "apps-prod" {
		t.Fatalf("ns name: %v", items["Namespace"])
	}

	d := items["Deployment"]
	if d == nil {
		t.Fatal("no Deployment in doc")
	}
	md := d["metadata"].(map[string]any)
	if md["name"] != "blog-r42" || md["namespace"] != "apps-prod" {
		t.Fatalf("deployment meta: %v", md)
	}
	spec := d["spec"].(map[string]any)
	if spec["replicas"] != 3.0 {
		t.Fatalf("replicas: %v", spec["replicas"])
	}
	strat := spec["strategy"].(map[string]any)["rollingUpdate"].(map[string]any)
	if strat["maxUnavailable"] != 0.0 {
		t.Fatalf("zero-gap requires maxUnavailable 0: %v", strat)
	}
	ct := spec["template"].(map[string]any)["spec"].(map[string]any)["containers"].([]any)[0].(map[string]any)
	if ct["image"] != "ghcr.io/o/blog:2" || ct["imagePullPolicy"] != "IfNotPresent" {
		t.Fatalf("container: %v", ct)
	}
	env := ct["env"].([]any)
	if len(env) != 2 || env[0].(map[string]any)["name"] != "A_KEY" {
		t.Fatalf("env list must be sorted: %v", env)
	}
	rp := ct["readinessProbe"].(map[string]any)
	get := rp["httpGet"].(map[string]any)
	if get["path"] != "/health" || get["port"] != 8080.0 {
		t.Fatalf("readiness probe: %v", rp)
	}
	if rp["periodSeconds"] != 2.0 || rp["failureThreshold"] != 5.0 {
		t.Fatalf("probe timing: %v", rp)
	}
	if _, ok := ct["livenessProbe"]; !ok {
		t.Fatal("healthcheck must also produce a livenessProbe")
	}

	svc := items["Service"]
	if svc == nil {
		t.Fatal("ports in spec must emit a Service")
	}
	svcspec := svc["spec"].(map[string]any)
	if svcspec["type"] != "ClusterIP" {
		t.Fatalf("service type: %v", svcspec)
	}
	ports := svcspec["ports"].([]any)
	p0 := ports[0].(map[string]any)
	if p0["port"] != 8080.0 || p0["targetPort"] != 80.0 {
		t.Fatalf("service port: %v", p0)
	}
	// The service selects on the app label only, so it spans the old
	// and new deployments during a swap.
	sel := svcspec["selector"].(map[string]any)
	if len(sel) != 1 || sel[kubeLabelApp] != "blog" {
		t.Fatalf("service selector: %v", sel)
	}
}

func TestKubeApplyDocMinimal(t *testing.T) {
	s := mustSpec(t, `{"appId":"a","releaseId":"r1","runtime":"k8s","source":{"kind":"image","url":"x:1"},"build":{"kind":"image"},"run":{}}`)
	doc, err := kubeApplyDoc(s, nil)
	if err != nil {
		t.Fatal(err)
	}
	items := listDoc(t, doc)
	if _, ok := items["Namespace"]; ok {
		t.Fatal("unpinned namespace must not emit a Namespace object")
	}
	if _, ok := items["Service"]; ok {
		t.Fatal("no ports must mean no Service")
	}
	d := items["Deployment"]
	md := d["metadata"].(map[string]any)
	if md["namespace"] != "default" {
		t.Fatalf("default namespace: %v", md)
	}
}

func TestKubeProbeTCP(t *testing.T) {
	hc := &Healthcheck{Kind: "tcp", Port: 5432, IntervalMs: 5000}
	p := kubeProbe(hc, false)
	if p["tcpSocket"].(map[string]any)["port"] != 5432 {
		t.Fatalf("tcp probe: %v", p)
	}
	if _, ok := p["httpGet"]; ok {
		t.Fatal("tcp probe must not carry httpGet")
	}
}

func TestParseEnvFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "env-1")
	if err := os.WriteFile(p, []byte("A=1\n# comment\n\nB=two=2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	env, err := parseEnvFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(env, map[string]string{"A": "1", "B": "two=2"}) {
		t.Fatalf("env: %v", env)
	}
	if err := os.WriteFile(p, []byte("not an env line\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := parseEnvFile(p); err == nil {
		t.Fatal("malformed line must error")
	}
}

// getenvMap adapts a map to the getenv signature resolveKubeconfig
// takes, so discovery order tests need no process env changes.
func getenvMap(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func existsSet(paths ...string) func(string) bool {
	set := map[string]bool{}
	for _, p := range paths {
		set[p] = true
	}
	return func(p string) bool { return set[p] }
}

func TestResolveKubeconfigOrder(t *testing.T) {
	kube := "/home/u/.kube/config"
	home := map[string]string{"HOME": "/home/u"}

	path, src, err := resolveKubeconfig("/etc/mine.conf", getenvMap(home), existsSet("/etc/mine.conf", kube))
	if err != nil || src != "flag" || path != "/etc/mine.conf" {
		t.Fatalf("flag source: %q %q %v", path, src, err)
	}
	if _, _, err := resolveKubeconfig("/missing.conf", getenvMap(home), existsSet(kube)); err == nil {
		t.Fatal("missing explicit kubeconfig must error")
	}
	path, src, err = resolveKubeconfig("", getenvMap(map[string]string{
		"HOME": "/home/u", "KUBECONFIG": "/etc/k1:/etc/k2",
	}), existsSet("/etc/k1", kube))
	if err != nil || src != "env" || path != "" {
		t.Fatalf("env source: %q %q %v", path, src, err)
	}
	// KUBECONFIG set but pointing nowhere falls through to the
	// default file.
	path, src, err = resolveKubeconfig("", getenvMap(map[string]string{
		"HOME": "/home/u", "KUBECONFIG": "/nope",
	}), existsSet(kube))
	if err != nil || src != "default" || path != kube {
		t.Fatalf("default source: %q %q %v", path, src, err)
	}
	_, src, err = resolveKubeconfig("", getenvMap(nil), existsSet(serviceAccountDir+"/token"))
	if err != nil || src != "in-cluster" {
		t.Fatalf("in-cluster source: %q %v", src, err)
	}
	if _, _, err := resolveKubeconfig("", getenvMap(nil), existsSet()); err == nil {
		t.Fatal("no config at all must error")
	}
}

// stdinRunner captures argv and stdin for kubectl argv tests; out
// is replayed to the call's output writer, failAt fails one call.
type stdinRunner struct {
	argv   [][]string
	stdin  []byte
	out    string
	failAt int
}

var errFake = errors.New("forced failure")

func (f *stdinRunner) Run(ctx context.Context, argv []string, opts CmdOpts, out io.Writer) error {
	f.argv = append(f.argv, append([]string(nil), argv...))
	if opts.In != nil {
		b, _ := io.ReadAll(opts.In)
		f.stdin = b
	}
	if out != nil && f.out != "" {
		_, _ = io.WriteString(out, f.out)
	}
	if f.failAt >= 0 && len(f.argv)-1 == f.failAt {
		return errFake
	}
	return nil
}

func testKube(r CmdRunner) *Kube {
	return &Kube{
		Name:   "kubectl",
		Source: "default",
		prefix: []string{"/usr/bin/kubectl", "--kubeconfig", "/home/u/.kube/config"},
		runner: r,
	}
}

func TestKubeArgv(t *testing.T) {
	f := &stdinRunner{failAt: -1}
	k := testKube(f)
	ctx := context.Background()
	if err := k.Apply(ctx, []byte(`{"kind":"List"}`), io.Discard); err != nil {
		t.Fatal(err)
	}
	if err := k.RolloutStatus(ctx, "blog-r42", "apps", 2*time.Minute, io.Discard); err != nil {
		t.Fatal(err)
	}
	if err := k.RolloutUndo(ctx, "blog-r42", "apps", io.Discard); err != nil {
		t.Fatal(err)
	}
	if err := k.DeleteDeployment(ctx, "blog-r41", "apps", io.Discard); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"/usr/bin/kubectl --kubeconfig /home/u/.kube/config apply -f -",
		"/usr/bin/kubectl --kubeconfig /home/u/.kube/config rollout status deployment/blog-r42 -n apps --timeout 2m0s",
		"/usr/bin/kubectl --kubeconfig /home/u/.kube/config rollout undo deployment/blog-r42 -n apps",
		"/usr/bin/kubectl --kubeconfig /home/u/.kube/config delete deployment blog-r41 -n apps --ignore-not-found",
	}
	for i, w := range want {
		got := strings.Join(f.argv[i], " ")
		if got != w {
			t.Fatalf("call %d: got %q want %q", i, got, w)
		}
	}
	if string(f.stdin) != `{"kind":"List"}` {
		t.Fatalf("apply stdin: %q", f.stdin)
	}
}

func TestKubePodsArgv(t *testing.T) {
	f := &stdinRunner{failAt: -1}
	f.out = `{"items":[{"status":{"phase":"Running"}},{"status":{"phase":"Pending"}}]}`
	k := testKube(f)
	total, running, err := k.Pods(context.Background(), "blog", "apps")
	if err != nil {
		t.Fatal(err)
	}
	if total != 2 || running != 1 {
		t.Fatalf("pods: %d/%d", running, total)
	}
	got := strings.Join(f.argv[0], " ")
	if !strings.Contains(got, "get pods -n apps -l "+kubeLabelApp+"=blog -o json") {
		t.Fatalf("pods argv: %s", got)
	}
}

func TestKubeDeploymentStatus(t *testing.T) {
	f := &stdinRunner{failAt: -1}
	f.out = `{"spec":{"replicas":3,"selector":{"matchLabels":{"` + kubeLabelApp + `":"blog"}}},"status":{"replicas":3,"readyReplicas":2}}`
	k := testKube(f)
	st, err := k.DeploymentStatus(context.Background(), "blog-r42", "apps")
	if err != nil {
		t.Fatal(err)
	}
	if !st.Found || st.Replicas != 3 || st.Ready != 2 || st.AppLabel != "blog" {
		t.Fatalf("status: %+v", st)
	}

	// A missing deployment reports Found=false, not an error.
	f2 := &stdinRunner{failAt: 0}
	f2.out = `Error from server (NotFound): deployments.apps "x" not found`
	st, err = testKube(f2).DeploymentStatus(context.Background(), "x", "apps")
	if err != nil || st.Found {
		t.Fatalf("not-found must be Found=false: %+v %v", st, err)
	}
}

func TestDetectKubeCandidates(t *testing.T) {
	// First candidate (kubectl) fails, k3s shim answers: the prefix
	// must carry the shim and the resolved kubeconfig flag.
	f := &stdinRunner{failAt: 0}
	k, err := detectKube("", getenvMap(map[string]string{"HOME": "/h"}),
		existsSet("/h/.kube/config"), f)
	if err != nil {
		t.Fatal(err)
	}
	if k.Name != "k3s kubectl" || k.Source != "default" {
		t.Fatalf("detect: %+v", k)
	}
	if !strings.Contains(strings.Join(k.prefix, " "), "k3s kubectl --kubeconfig /h/.kube/config") {
		t.Fatalf("prefix: %v", k.prefix)
	}
	if _, err := detectKube("", getenvMap(nil), existsSet(), &stdinRunner{failAt: -1}); err == nil {
		t.Fatal("no kubeconfig must fail before probing binaries")
	}
}
