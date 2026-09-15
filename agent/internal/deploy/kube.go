package deploy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// RuntimeK8s is the spec runtime value that routes a job to the
// kubectl path instead of a local container runtime.
const RuntimeK8s = "k8s"

// Pod labels written by the k8s manifest builder. The app label is
// stable across releases so the Service selector spans the old and
// new deployment during a swap; the release label isolates one
// deployment's pods.
const (
	kubeLabelApp     = "wharfinger-agent/app"
	kubeLabelRelease = "wharfinger-agent/release"
	kubeManagedBy    = "wharfinger-agent/managed-by"
)

// serviceAccountDir marks an in-cluster pod environment: the token
// file existing means kubectl can authenticate without a kubeconfig.
const serviceAccountDir = "/var/run/secrets/kubernetes.io/serviceaccount"

// Kube drives kubectl with fixed argv. prefix holds the resolved
// invocation: the binary path (or the k3s shim) plus --kubeconfig
// when discovery produced an explicit path.
type Kube struct {
	Name   string // "kubectl" | "k3s kubectl"
	Source string // which discovery step resolved config: flag|env|default|in-cluster

	prefix []string
	runner CmdRunner
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// resolveKubeconfig picks a kubeconfig source in kubectl's own
// order: the explicit flag/env value, KUBECONFIG, ~/.kube/config,
// then the in-cluster service account. The returned path is empty
// for env and in-cluster sources because kubectl resolves those
// itself; source always reports which step won.
func resolveKubeconfig(explicit string, getenv func(string) string, exists func(string) bool) (path, source string, err error) {
	if explicit != "" {
		if !exists(explicit) {
			return "", "", fmt.Errorf("kubeconfig %s not found", explicit)
		}
		return explicit, "flag", nil
	}
	if kc := getenv("KUBECONFIG"); kc != "" {
		first := strings.Split(kc, string(os.PathListSeparator))[0]
		if exists(first) {
			return "", "env", nil
		}
	}
	if home := getenv("HOME"); home != "" {
		p := filepath.Join(home, ".kube", "config")
		if exists(p) {
			return p, "default", nil
		}
	}
	if exists(serviceAccountDir + "/token") {
		return "", "in-cluster", nil
	}
	return "", "", fmt.Errorf("no kubeconfig (tried flag, KUBECONFIG, ~/.kube/config, in-cluster)")
}

// DetectKube resolves a kubeconfig and confirms a kubectl binary
// answers version --client. k3s hosts without a standalone kubectl
// are driven through the k3s shim (k3s kubectl). Detection runs once
// at startup; the result is cached on the executor.
func DetectKube(explicit string, r CmdRunner) (*Kube, error) {
	return detectKube(explicit, os.Getenv, fileExists, r)
}

func detectKube(explicit string, getenv func(string) string, exists func(string) bool, r CmdRunner) (*Kube, error) {
	if r == nil {
		r = ExecRunner{}
	}
	path, source, err := resolveKubeconfig(explicit, getenv, exists)
	if err != nil {
		return nil, err
	}
	candidates := []struct {
		name string
		base []string
	}{
		{"kubectl", []string{resolveBin("kubectl")}},
		{"k3s kubectl", []string{resolveBin("k3s"), "kubectl"}},
	}
	for _, c := range candidates {
		prefix := append([]string(nil), c.base...)
		if path != "" {
			prefix = append(prefix, "--kubeconfig", path)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		err := r.Run(ctx, append(append([]string(nil), prefix...), "version", "--client"), CmdOpts{}, io.Discard)
		cancel()
		if err == nil {
			return &Kube{Name: c.name, Source: source, prefix: prefix, runner: r}, nil
		}
	}
	return nil, fmt.Errorf("no working kubectl (tried kubectl, k3s kubectl)")
}

func (k *Kube) run(ctx context.Context, args []string, in io.Reader, out io.Writer) error {
	argv := append(append([]string(nil), k.prefix...), args...)
	return k.runner.Run(ctx, argv, CmdOpts{In: in}, out)
}

// Apply feeds the rendered manifest list to kubectl apply -f - over
// stdin, so the document never lands on disk.
func (k *Kube) Apply(ctx context.Context, doc []byte, out io.Writer) error {
	ctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	return k.run(ctx, []string{"apply", "-f", "-"}, bytes.NewReader(doc), out)
}

// RolloutStatus blocks until the deployment finishes rolling or the
// deadline passes; kubectl itself enforces the --timeout window.
func (k *Kube) RolloutStatus(ctx context.Context, name, ns string, window time.Duration, out io.Writer) error {
	ctx, cancel := context.WithTimeout(ctx, window+30*time.Second)
	defer cancel()
	return k.run(ctx, []string{
		"rollout", "status", "deployment/" + name, "-n", ns,
		"--timeout", window.String(),
	}, nil, out)
}

// RolloutUndo reverts a deployment to its previous revision. It only
// has history when the same release name was applied before (a job
// retry); on a fresh deployment it reports no history and the caller
// deletes the failed object instead.
func (k *Kube) RolloutUndo(ctx context.Context, name, ns string, out io.Writer) error {
	ctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	return k.run(ctx, []string{"rollout", "undo", "deployment/" + name, "-n", ns}, nil, out)
}

// DeleteDeployment removes a deployment; missing objects are fine.
func (k *Kube) DeleteDeployment(ctx context.Context, name, ns string, out io.Writer) error {
	ctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	return k.run(ctx, []string{"delete", "deployment", name, "-n", ns, "--ignore-not-found"}, nil, out)
}

// DeleteApp removes every deployment and service carrying the app
// label: teardown for previews and deleted apps. Missing objects
// are fine; the label selector is what scopes the delete.
func (k *Kube) DeleteApp(ctx context.Context, appLabel, ns string, out io.Writer) error {
	ctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	return k.run(ctx, []string{
		"delete", "deployment,service", "-l", kubeLabelApp + "=" + appLabel,
		"-n", ns, "--ignore-not-found",
	}, nil, out)
}

// KubeDeployStatus is the observed state of one deployment, used by
// reconcile to recover job outcomes after an agent restart.
type KubeDeployStatus struct {
	Found    bool
	Replicas int
	Ready    int
	AppLabel string // selector value under kubeLabelApp
}

type kubeDeploymentDoc struct {
	Spec struct {
		Replicas int `json:"replicas"`
		Selector struct {
			MatchLabels map[string]string `json:"matchLabels"`
		} `json:"selector"`
	} `json:"spec"`
	Status struct {
		Replicas      int `json:"replicas"`
		ReadyReplicas int `json:"readyReplicas"`
	} `json:"status"`
}

// DeploymentStatus inspects one deployment by name. A missing
// deployment yields Found=false, not an error.
func (k *Kube) DeploymentStatus(ctx context.Context, name, ns string) (KubeDeployStatus, error) {
	ctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	ring := newRingBuf(1 << 20)
	err := k.run(ctx, []string{"get", "deployment", name, "-n", ns, "-o", "json"}, nil, ring)
	if err != nil {
		if notFound(ring.String()) {
			return KubeDeployStatus{}, nil
		}
		return KubeDeployStatus{}, err
	}
	var d kubeDeploymentDoc
	if err := json.Unmarshal([]byte(ring.String()), &d); err != nil {
		return KubeDeployStatus{}, fmt.Errorf("deployment json: %w", err)
	}
	return KubeDeployStatus{
		Found:    true,
		Replicas: d.Spec.Replicas,
		Ready:    d.Status.ReadyReplicas,
		AppLabel: d.Spec.Selector.MatchLabels[kubeLabelApp],
	}, nil
}

type kubePodListDoc struct {
	Items []struct {
		Status struct {
			Phase string `json:"phase"`
		} `json:"status"`
	} `json:"items"`
}

// Pods counts pods carrying the app label, for reconcile reporting.
// The label spans releases so a mid-swap restart still sees both
// deployments' pods.
func (k *Kube) Pods(ctx context.Context, appLabel, ns string) (total, running int, err error) {
	ctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	ring := newRingBuf(1 << 20)
	err = k.run(ctx, []string{
		"get", "pods", "-n", ns, "-l", kubeLabelApp + "=" + appLabel, "-o", "json",
	}, nil, ring)
	if err != nil {
		return 0, 0, err
	}
	var d kubePodListDoc
	if err := json.Unmarshal([]byte(ring.String()), &d); err != nil {
		return 0, 0, fmt.Errorf("pod list json: %w", err)
	}
	for _, p := range d.Items {
		total++
		if p.Status.Phase == "Running" {
			running++
		}
	}
	return total, running, nil
}

// dns1123 folds an arbitrary nameRE string into the DNS-1123 label
// alphabet Kubernetes object names require. Distinct spec ids can
// fold to the same label (My_App and my-app); the appId naming rules
// on the hub keep real collisions out.
func dns1123(v string) string {
	v = strings.ToLower(v)
	var b strings.Builder
	for _, r := range v {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	s := strings.Trim(b.String(), "-")
	if len(s) > 63 {
		s = strings.Trim(s[:63], "-")
	}
	return s
}

// kubeNamespace resolves the target namespace: the spec pin, or the
// kubectl default.
func (s *Spec) kubeNamespace() string {
	if s.Namespace != "" {
		return s.Namespace
	}
	return "default"
}

// kubeDeployName follows the container naming convention
// <app>-<release>, folded to DNS-1123.
func (s *Spec) kubeDeployName() string {
	return dns1123(s.AppID + "-" + s.ReleaseID)
}

func (s *Spec) kubeAppLabel() string     { return dns1123(s.AppID) }
func (s *Spec) kubeReleaseLabel() string { return dns1123(s.ReleaseID) }

func (s *Spec) kubeReplicas() int {
	if s.Run.Replicas > 0 {
		return s.Run.Replicas
	}
	return 1
}

// parseEnvFile reads KEY=VALUE lines written by writeEnvFile (or a
// pre-staged file of the same shape) back into a map for the k8s env
// list. Comments and blank lines are skipped; keys must pass the
// same envKeyRe the writer enforced.
func parseEnvFile(path string) (map[string]string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	env := map[string]string{}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok || !envKeyRe.MatchString(k) {
			return nil, fmt.Errorf("env file %s: bad line %q", path, line)
		}
		env[k] = v
	}
	return env, nil
}

// kubeEnvList renders the env map as a sorted k8s env list. Sorting
// keeps the manifest byte-stable for tests and audit diffs.
func kubeEnvList(env map[string]string) []any {
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]any, 0, len(keys))
	for _, k := range keys {
		out = append(out, map[string]any{"name": k, "value": env[k]})
	}
	return out
}

// kubeProbe maps the spec healthcheck onto a probe object shared by
// readiness and liveness. liveness adds a startup grace so a slow
// boot is not restarted before readiness ever had a chance.
func kubeProbe(hc *Healthcheck, liveness bool) map[string]any {
	period := 10
	if hc.IntervalMs > 0 {
		period = max(hc.IntervalMs/1000, 1)
	}
	failures := hc.Retries
	if failures <= 0 {
		failures = 3
	}
	probe := map[string]any{
		"periodSeconds":    period,
		"timeoutSeconds":   5,
		"failureThreshold": failures,
	}
	if liveness {
		probe["initialDelaySeconds"] = 15
	}
	if hc.Kind == "tcp" {
		probe["tcpSocket"] = map[string]any{"port": hc.Port}
	} else {
		path := hc.Path
		if path == "" {
			path = "/"
		}
		if !strings.HasPrefix(path, "/") {
			path = "/" + path
		}
		probe["httpGet"] = map[string]any{
			"path":   path,
			"port":   hc.Port,
			"scheme": "HTTP",
		}
	}
	return probe
}

// kubeDeployment builds the Deployment object. The name follows the
// <app>-<release> container convention: each release is its own
// deployment, so a failed apply never mutates the live one, and the
// swap is delete-old-after-ready just like the container path.
// maxUnavailable 0 keeps every old pod alive until the new pods are
// ready, which is what makes the update zero-gap.
func kubeDeployment(s *Spec, env map[string]string) map[string]any {
	appLabel := s.kubeAppLabel()
	relLabel := s.kubeReleaseLabel()
	labels := map[string]string{
		kubeLabelApp:     appLabel,
		kubeLabelRelease: relLabel,
		kubeManagedBy:    "wharfinger-agent",
	}
	container := map[string]any{
		"name":            appLabel,
		"image":           s.effectiveImage(),
		"imagePullPolicy": "IfNotPresent",
	}
	if envList := kubeEnvList(env); len(envList) > 0 {
		container["env"] = envList
	}
	if len(s.Run.Ports) > 0 {
		ports := make([]any, 0, len(s.Run.Ports))
		for _, p := range s.Run.Ports {
			ports = append(ports, map[string]any{
				"containerPort": p.Container,
				"protocol":      "TCP",
			})
		}
		container["ports"] = ports
	}
	if hc := s.Run.Healthcheck; hc != nil {
		container["readinessProbe"] = kubeProbe(hc, false)
		container["livenessProbe"] = kubeProbe(hc, true)
	}
	return map[string]any{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata": map[string]any{
			"name":      s.kubeDeployName(),
			"namespace": s.kubeNamespace(),
			"labels":    labels,
		},
		"spec": map[string]any{
			"replicas":             s.kubeReplicas(),
			"revisionHistoryLimit": 5,
			"strategy": map[string]any{
				"type": "RollingUpdate",
				"rollingUpdate": map[string]any{
					"maxUnavailable": 0,
					"maxSurge":       1,
				},
			},
			"selector": map[string]any{"matchLabels": labels},
			"template": map[string]any{
				"metadata": map[string]any{"labels": labels},
				"spec":     map[string]any{"containers": []any{container}},
			},
		},
	}
}

// kubeService builds the stable per-app ClusterIP service. The
// selector matches the app label only, so during a swap it spans the
// pods of both the old and new deployments; host ports in the spec
// become service ports, container ports the target.
func kubeService(s *Spec) map[string]any {
	ports := make([]any, 0, len(s.Run.Ports))
	for _, p := range s.Run.Ports {
		ports = append(ports, map[string]any{
			"name":       "p" + strconv.Itoa(p.Host) + "-" + strconv.Itoa(p.Container),
			"port":       p.Host,
			"targetPort": p.Container,
			"protocol":   "TCP",
		})
	}
	return map[string]any{
		"apiVersion": "v1",
		"kind":       "Service",
		"metadata": map[string]any{
			"name":      s.kubeAppLabel(),
			"namespace": s.kubeNamespace(),
			"labels": map[string]string{
				kubeLabelApp:  s.kubeAppLabel(),
				kubeManagedBy: "wharfinger-agent",
			},
		},
		"spec": map[string]any{
			"type":     "ClusterIP",
			"selector": map[string]string{kubeLabelApp: s.kubeAppLabel()},
			"ports":    ports,
		},
	}
}

// kubeApplyDoc renders the whole deploy as one v1 List: kubectl
// accepts JSON on stdin, so manifests are generated in-process with
// no yaml dependency and no temp files. A Namespace object is only
// emitted for a spec-pinned namespace; the default namespace always
// exists and a namespace-scoped credential may not be allowed to
// create one.
func kubeApplyDoc(s *Spec, env map[string]string) ([]byte, error) {
	items := []any{}
	if s.Namespace != "" {
		items = append(items, map[string]any{
			"apiVersion": "v1",
			"kind":       "Namespace",
			"metadata": map[string]any{
				"name":   s.Namespace,
				"labels": map[string]string{kubeManagedBy: "wharfinger-agent"},
			},
		})
	}
	items = append(items, kubeDeployment(s, env))
	if len(s.Run.Ports) > 0 {
		items = append(items, kubeService(s))
	}
	doc := map[string]any{
		"apiVersion": "v1",
		"kind":       "List",
		"items":      items,
	}
	return json.Marshal(doc)
}

// kubeRolloutWindow derives the rollout deadline from the spec
// healthcheck, matching the container healthcheck window logic.
func kubeRolloutWindow(s *Spec) time.Duration {
	w := 2 * time.Minute
	if hc := s.Run.Healthcheck; hc != nil && hc.TimeoutMs > 0 {
		w = time.Duration(hc.TimeoutMs) * time.Millisecond
	}
	if w > healthWindowCap {
		w = healthWindowCap
	}
	return w
}
