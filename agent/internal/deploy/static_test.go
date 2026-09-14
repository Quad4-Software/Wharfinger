package deploy

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The shape the hub emits for a static app: repo clone + subdir
// serve root, no image, no ports.
const staticSpec = `{
	"appId": "site",
	"releaseId": "r9",
	"jobKey": "k1",
	"source": {"kind": "static", "url": "git@example.com:o/site.git", "ref": "main", "subdir": "dist"},
	"build": {"kind": "static", "context": "dist"},
	"run": {"envRef": "site", "ports": []},
	"route": {"domains": ["site.example.com"]}
}`

func TestStaticSpecParses(t *testing.T) {
	s, err := ParseSpec(staticSpec)
	if err != nil {
		t.Fatal(err)
	}
	if !isStaticSpec(s) {
		t.Fatal("static spec not detected")
	}
	if d := s.Domains(); len(d) != 1 || d[0] != "site.example.com" {
		t.Fatalf("domains: %v", d)
	}
}

func TestIsStaticSpec(t *testing.T) {
	for _, c := range []struct {
		name string
		spec Spec
		want bool
	}{
		{"static source", Spec{Source: Source{Kind: "static"}}, true},
		{"static build on git", Spec{Source: Source{Kind: "git"}, Build: Build{Kind: "static"}}, true},
		{"dockerfile", Spec{Source: Source{Kind: "git"}, Build: Build{Kind: "dockerfile"}}, false},
		{"image", Spec{Source: Source{Kind: "image"}, Build: Build{Kind: "image"}}, false},
	} {
		if got := isStaticSpec(&c.spec); got != c.want {
			t.Fatalf("%s: got %v", c.name, got)
		}
	}
}

// A pre-staged static source carries no url and still validates.
func TestStaticSpecPrestaged(t *testing.T) {
	s, err := ParseSpec(`{
		"appId": "site", "releaseId": "r1", "jobKey": "k",
		"source": {"kind": "static", "subdir": "public"},
		"build": {"kind": "static"}, "run": {}
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if s.Source.URL != "" {
		t.Fatalf("url: %q", s.Source.URL)
	}
}

func TestCopyTree(t *testing.T) {
	src := t.TempDir()
	mk := func(rel, body string) {
		p := filepath.Join(src, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mk("index.html", "<h1>hi</h1>")
	mk("assets/app.js", "x=1")
	mk(".git/HEAD", "ref: refs/heads/main")
	if err := os.Symlink("/etc/passwd", filepath.Join(src, "escape")); err != nil {
		t.Fatal(err)
	}

	dst := filepath.Join(t.TempDir(), "out")
	files, skipped, err := copyTree(src, dst)
	if err != nil {
		t.Fatal(err)
	}
	if files != 2 {
		t.Fatalf("files: %d", files)
	}
	if skipped != 1 {
		t.Fatalf("skipped: %d", skipped)
	}
	b, err := os.ReadFile(filepath.Join(dst, "index.html"))
	if err != nil || string(b) != "<h1>hi</h1>" {
		t.Fatalf("index.html: %v %q", err, b)
	}
	if _, err := os.Stat(filepath.Join(dst, ".git")); !os.IsNotExist(err) {
		t.Fatal(".git leaked into the artifact tree")
	}
	if _, err := os.Lstat(filepath.Join(dst, "escape")); !os.IsNotExist(err) {
		t.Fatal("symlink leaked into the artifact tree")
	}
}

func TestVerifyStaticRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "dist"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "dist", "index.html"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyStaticRoot(root, "dist"); err != nil {
		t.Fatalf("valid root: %v", err)
	}
	if _, err := verifyStaticRoot(root, "../dist"); err == nil {
		t.Fatal("traversal accepted")
	}
	if _, err := verifyStaticRoot(root, "missing"); err == nil {
		t.Fatal("missing root accepted")
	}
	empty := filepath.Join(root, "empty")
	if err := os.Mkdir(empty, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyStaticRoot(root, "empty"); err == nil ||
		!strings.Contains(err.Error(), "no files") {
		t.Fatalf("empty root: %v", err)
	}
}

func TestSwapStaticRoot(t *testing.T) {
	state := t.TempDir()
	link := filepath.Join(state, "src", "site")
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	r1 := filepath.Join(state, "static", "site", "rel-r1")
	r2 := filepath.Join(state, "static", "site", "rel-r2")
	for _, d := range []string{r1, r2} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	// Fresh publish creates the link.
	if err := swapStaticRoot(link, r1); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.Readlink(link); got != r1 {
		t.Fatalf("link: %q", got)
	}
	// Second publish atomically repoints.
	if err := swapStaticRoot(link, r2); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.Readlink(link); got != r2 {
		t.Fatalf("link after swap: %q", got)
	}
	// A real directory at the link path is moved aside, not served.
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(link, "dist"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := swapStaticRoot(link, r1); err != nil {
		t.Fatal(err)
	}
	if st, err := os.Lstat(link); err != nil || st.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("link is not a symlink: %v", err)
	}
	if _, err := os.Stat(link + ".hold"); !os.IsNotExist(err) {
		t.Fatal("hold dir not cleaned up")
	}
}

func TestPruneStaticReleases(t *testing.T) {
	state := t.TempDir()
	e := &Executor{stateDir: state}
	base := filepath.Join(state, "static", "site")
	old := filepath.Join(base, "rel-old")
	mid := filepath.Join(base, "rel-mid")
	for _, d := range []string{old, mid, filepath.Join(base, "rel-live"), filepath.Join(base, "repo")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// Force mtime ordering: oldest gets pruned.
	past := time.Now().Add(-time.Hour)
	if err := os.Chtimes(old, past, past); err != nil {
		t.Fatal(err)
	}
	e.pruneStaticReleases("site", "live", io.Discard)
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("oldest release not pruned")
	}
	for _, keep := range []string{"rel-mid", "rel-live", "repo"} {
		if _, err := os.Stat(filepath.Join(base, keep)); err != nil {
			t.Fatalf("%s pruned: %v", keep, err)
		}
	}
}
