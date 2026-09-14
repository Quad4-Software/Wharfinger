package deploy

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

// Spec is the frozen deploy spec the hub bakes into a job. It
// follows src/lib/shared/deploy.ts plus the executor contract in
// .agents/skills/deploy-pipeline. A few alternate spellings are
// accepted (prevRelease, route.domains, envRef) so a hub spec
// revision does not strand queued jobs.
type Spec struct {
	AppID     string `json:"appId"`
	ReleaseID string `json:"releaseId"`
	JobKey    string `json:"jobKey"`
	Source    Source `json:"source"`
	Build     Build  `json:"build"`
	Run       Run    `json:"run"`
	Route     Route  `json:"route"`
	// Runtime optionally pins the deploy runtime ("podman", "docker",
	// or "k8s"); empty defers to local detection.
	Runtime string `json:"runtime"`
	// Namespace scopes a k8s deploy; empty uses the kubectl default
	// namespace. Container runtimes ignore it.
	Namespace string `json:"namespace"`
	// PrevContainer names the currently live release. The hub has
	// used both spellings; both decode here.
	PrevContainer *PrevRef     `json:"prevContainer"`
	PrevRelease   *PrevRelease `json:"prevRelease"`
	// Rollback marks this job as a hub-decided rollback deploy; the
	// executor treats it like any other deploy. AutoRollback is
	// informational only: the executor reports failures and the hub
	// decides whether to enqueue a rollback job.
	Rollback     bool   `json:"rollback"`
	RollbackOf   string `json:"rollbackOf"`
	AutoRollback bool   `json:"autoRollback"`
}

type Source struct {
	Kind    string `json:"kind"` // git | image | static
	URL     string `json:"url"`
	Ref     string `json:"ref"`
	Commit  string `json:"commit"`
	Subdir  string `json:"subdir"`
	KeyFile string `json:"keyFile"` // deploy key path, must live under the state dir
}

type Build struct {
	Kind       string            `json:"kind"` // dockerfile | static | image
	Dockerfile string            `json:"dockerfile"`
	Context    string            `json:"context"`
	Args       map[string]string `json:"args"`
}

type Port struct {
	Host      int `json:"host"`
	Container int `json:"container"`
	// Local binds the published port to 127.0.0.1 only: reachable by
	// the edge proxy and the healthcheck, not from outside the host.
	Local bool `json:"local"`
}

type Healthcheck struct {
	Kind       string `json:"kind"` // http | tcp
	Port       int    `json:"port"`
	Path       string `json:"path"`
	IntervalMs int    `json:"intervalMs"`
	TimeoutMs  int    `json:"timeoutMs"`
	Retries    int    `json:"retries"`
}

type Run struct {
	Image       string       `json:"image"`
	EnvFile     string       `json:"envFile"`
	EnvRef      string       `json:"envRef"`
	Ports       []Port       `json:"ports"`
	Healthcheck *Healthcheck `json:"healthcheck"`
	Domains     []string     `json:"domains"`
	// Replicas is the k8s pod count (1-10, 0 means default 1);
	// container runtimes ignore it.
	Replicas int `json:"replicas"`
}

type Route struct {
	Domains []string `json:"domains"`
}

type PrevRef struct {
	Name      string `json:"name"`
	ReleaseID string `json:"releaseId"`
	Image     string `json:"image"`
}

// PrevRelease is the hub-side alternate shape for the previous live
// release; it carries the container name under a different key.
type PrevRelease struct {
	ID        string  `json:"id"`
	Container string  `json:"container"`
	Image     *string `json:"image"`
}

// ParseSpec decodes and validates the spec string carried by a
// claimed job.
func ParseSpec(raw string) (*Spec, error) {
	var s Spec
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		return nil, fmt.Errorf("spec json: %w", err)
	}
	if err := s.Validate(); err != nil {
		return nil, err
	}
	return &s, nil
}

// Prev normalizes the previous-release reference across the two
// accepted spellings.
func (s *Spec) Prev() *PrevRef {
	if s.PrevContainer != nil && s.PrevContainer.Name != "" {
		return s.PrevContainer
	}
	if s.PrevRelease != nil && s.PrevRelease.Container != "" {
		img := ""
		if s.PrevRelease.Image != nil {
			img = *s.PrevRelease.Image
		}
		return &PrevRef{
			Name:      s.PrevRelease.Container,
			ReleaseID: s.PrevRelease.ID,
			Image:     img,
		}
	}
	return nil
}

// Domains merges run.domains and route.domains; either spelling may
// carry the route list.
func (s *Spec) Domains() []string {
	out := append([]string(nil), s.Run.Domains...)
	for _, d := range s.Route.Domains {
		found := false
		for _, x := range out {
			if x == d {
				found = true
				break
			}
		}
		if !found {
			out = append(out, d)
		}
	}
	return out
}

// ContainerName is the fixed <app>-<release> convention; the route
// layer keys on it for the zero-gap swap.
func (s *Spec) ContainerName() string {
	return s.AppID + "-" + s.ReleaseID
}

// effectiveImage is the registry image to run when no dockerfile
// build produces a local tag.
func (s *Spec) effectiveImage() string {
	if s.Run.Image != "" {
		return s.Run.Image
	}
	if s.Source.Kind == "image" {
		return s.Source.URL
	}
	return ""
}

// ImageTag is the local build tag <app>:<release> with characters
// outside the tag alphabet folded to dashes.
func (s *Spec) ImageTag() string {
	fold := func(v string) string {
		v = strings.ToLower(v)
		var b strings.Builder
		for _, r := range v {
			switch {
			case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_', r == '.', r == '-':
				b.WriteRune(r)
			default:
				b.WriteByte('-')
			}
		}
		return b.String()
	}
	tag := fold(s.ReleaseID)
	if tag == "" {
		tag = "latest"
	}
	return fold(s.AppID) + ":" + tag
}

// nameRE restricts names that land in container names and image
// tags. argv is already injection-safe (fixed slices); this keeps
// the resulting runtime objects addressable.
var nameRE = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)

// namespaceRE is the DNS-1123 label alphabet Kubernetes requires for
// namespace names: lowercase alphanumerics and dashes, 63 chars max.
var namespaceRE = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// gitURLRE, refRE, and imageRE bound every string that lands in an
// argv position. The hub validates too; the agent re-checks because
// a spec is only as trustworthy as the channel that carried it.
var gitURLRE = regexp.MustCompile(`^(https://|ssh://|git@)[^ \t\n]{2,500}$`)
var refRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$`)
var imageRE = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,255}$`)

// safeRel reports whether rel is a clean relative path: no
// traversal, no absolute anchor, no tilde expansion.
func safeRel(rel string) bool {
	return rel == "" ||
		(rel != ".." && !strings.HasPrefix(rel, "../") && !strings.Contains(rel, "/../") &&
			!filepath.IsAbs(rel) && !strings.HasPrefix(rel, "~") &&
			!strings.ContainsAny(rel, "\x00\n\r"))
}

// Validate rejects specs the executor cannot run safely or at all.
func (s *Spec) Validate() error {
	if !nameRE.MatchString(s.AppID) {
		return fmt.Errorf("appId %q is not a valid name", s.AppID)
	}
	if !nameRE.MatchString(s.ReleaseID) {
		return fmt.Errorf("releaseId %q is not a valid name", s.ReleaseID)
	}
	switch s.Runtime {
	case "", "podman", "docker", "k8s":
	default:
		return fmt.Errorf("runtime %q unsupported", s.Runtime)
	}
	if s.Namespace != "" && !namespaceRE.MatchString(s.Namespace) {
		return fmt.Errorf("namespace %q is not a DNS-1123 label", s.Namespace)
	}
	if s.Run.Replicas < 0 || s.Run.Replicas > 10 {
		return fmt.Errorf("run.replicas %d out of range (1-10)", s.Run.Replicas)
	}
	switch s.Source.Kind {
	case "git":
		if !gitURLRE.MatchString(s.Source.URL) {
			return fmt.Errorf("git url must be https://, ssh://, or git@")
		}
		if s.Source.Ref != "" && !refRE.MatchString(s.Source.Ref) {
			return fmt.Errorf("git ref %q is not a safe reference", s.Source.Ref)
		}
		if s.Source.Commit != "" && !refRE.MatchString(s.Source.Commit) {
			return fmt.Errorf("git commit %q is not a safe reference", s.Source.Commit)
		}
	case "image":
		if s.effectiveImage() == "" {
			return fmt.Errorf("image source requires source.url or run.image")
		}
		if !imageRE.MatchString(s.effectiveImage()) {
			return fmt.Errorf("image reference %q is not safe", s.effectiveImage())
		}
	case "static":
		// Pre-staged checkout under the state dir; nothing to fetch.
	default:
		return fmt.Errorf("source kind %q unsupported", s.Source.Kind)
	}
	if !safeRel(s.Source.Subdir) {
		return fmt.Errorf("source.subdir %q escapes the checkout", s.Source.Subdir)
	}
	if !safeRel(s.Build.Context) {
		return fmt.Errorf("build.context %q escapes the checkout", s.Build.Context)
	}
	if !safeRel(s.Build.Dockerfile) {
		return fmt.Errorf("build.dockerfile %q escapes the checkout", s.Build.Dockerfile)
	}
	switch s.Build.Kind {
	case "", "dockerfile":
		if s.Source.Kind == "image" {
			return fmt.Errorf("dockerfile build requires a source checkout")
		}
	case "static", "image":
		if s.effectiveImage() == "" {
			return fmt.Errorf("build kind %q requires run.image or an image source", s.Build.Kind)
		}
	default:
		return fmt.Errorf("build kind %q unsupported", s.Build.Kind)
	}
	if strings.ContainsAny(s.Source.KeyFile, " \t\n\"'") {
		return fmt.Errorf("keyFile contains unsafe characters")
	}
	for i, p := range s.Run.Ports {
		if p.Host <= 0 || p.Host > 65535 || p.Container <= 0 || p.Container > 65535 {
			return fmt.Errorf("run.ports[%d] out of range", i)
		}
	}
	if hc := s.Run.Healthcheck; hc != nil {
		if hc.Kind != "http" && hc.Kind != "tcp" {
			return fmt.Errorf("healthcheck kind %q unsupported", hc.Kind)
		}
		if hc.Port <= 0 || hc.Port > 65535 {
			return fmt.Errorf("healthcheck port %d out of range", hc.Port)
		}
	}
	if prev := s.Prev(); prev != nil && !nameRE.MatchString(prev.Name) {
		return fmt.Errorf("previous container name %q is not valid", prev.Name)
	}
	return nil
}
