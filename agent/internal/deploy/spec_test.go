package deploy

import (
	"strings"
	"testing"
)

const goodSpec = `{
	"appId": "blog",
	"releaseId": "r42",
	"jobKey": "k1",
	"source": {"kind": "git", "url": "git@example.com:org/blog.git", "ref": "main"},
	"build": {"kind": "dockerfile", "dockerfile": "Dockerfile", "context": "web"},
	"run": {
		"ports": [{"host": 8080, "container": 80}],
		"healthcheck": {"kind": "http", "port": 8080, "path": "/health", "intervalMs": 2000, "timeoutMs": 60000, "retries": 10},
		"domains": ["blog.example.com"]
	},
	"prevContainer": {"name": "blog-r41", "releaseId": "r41"}
}`

func TestParseSpecOK(t *testing.T) {
	s, err := ParseSpec(goodSpec)
	if err != nil {
		t.Fatal(err)
	}
	if s.AppID != "blog" || s.ReleaseID != "r42" {
		t.Fatalf("ids: %+v", s)
	}
	if s.ContainerName() != "blog-r42" {
		t.Fatalf("container name: %s", s.ContainerName())
	}
	prev := s.Prev()
	if prev == nil || prev.Name != "blog-r41" || prev.ReleaseID != "r41" {
		t.Fatalf("prev: %+v", prev)
	}
	if got := s.ImageTag(); got != "blog:r42" {
		t.Fatalf("image tag: %s", got)
	}
}

func TestParseSpecPrevReleaseAlias(t *testing.T) {
	raw := `{
		"appId": "app", "releaseId": "r2", "jobKey": "k",
		"source": {"kind": "image", "url": "ghcr.io/o/app:2"},
		"build": {"kind": "image"},
		"run": {"ports": []},
		"route": {"domains": ["a.example.com"]},
		"prevRelease": {"id": "r1", "container": "app-r1", "image": "ghcr.io/o/app:1"}
	}`
	s, err := ParseSpec(raw)
	if err != nil {
		t.Fatal(err)
	}
	prev := s.Prev()
	if prev == nil || prev.Name != "app-r1" || prev.Image != "ghcr.io/o/app:1" {
		t.Fatalf("prevRelease alias: %+v", prev)
	}
	if d := s.Domains(); len(d) != 1 || d[0] != "a.example.com" {
		t.Fatalf("route domains: %v", d)
	}
	if s.effectiveImage() != "ghcr.io/o/app:2" {
		t.Fatalf("effective image: %s", s.effectiveImage())
	}
}

func TestSpecValidation(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string // substring expected in the error
	}{
		{"bad json", `{`, "spec json"},
		{"bad appId", `{"appId": "a/b", "releaseId": "r1", "source": {"kind": "static"}, "build": {"kind": "static"}, "run": {"image": "x:1"}}`, "appId"},
		{"empty appId", `{"appId": "", "releaseId": "r1", "source": {"kind": "static"}, "build": {"kind": "static"}, "run": {"image": "x:1"}}`, "appId"},
		{"git no url", `{"appId": "a", "releaseId": "r1", "source": {"kind": "git"}, "build": {"kind": "dockerfile"}, "run": {}}`, "url"},
		{"unknown source", `{"appId": "a", "releaseId": "r1", "source": {"kind": "svn"}, "build": {"kind": "dockerfile"}, "run": {}}`, "source kind"},
		{"dockerfile on image source", `{"appId": "a", "releaseId": "r1", "source": {"kind": "image", "url": "x:1"}, "build": {"kind": "dockerfile"}, "run": {}}`, "checkout"},
		{"image build no image", `{"appId": "a", "releaseId": "r1", "source": {"kind": "static"}, "build": {"kind": "image"}, "run": {}}`, "run.image"},
		{"static source bad url", `{"appId": "a", "releaseId": "r1", "source": {"kind": "static", "url": "file:///etc"}, "build": {"kind": "static"}, "run": {}}`, "git url"},
		{"static build on image source", `{"appId": "a", "releaseId": "r1", "source": {"kind": "image", "url": "x:1"}, "build": {"kind": "static"}, "run": {}}`, "checkout"},
		{"bad port", `{"appId": "a", "releaseId": "r1", "source": {"kind": "static"}, "build": {"kind": "static"}, "run": {"image": "x:1", "ports": [{"host": 0, "container": 80}]}}`, "ports"},
		{"bad hc kind", `{"appId": "a", "releaseId": "r1", "source": {"kind": "static"}, "build": {"kind": "static"}, "run": {"image": "x:1", "healthcheck": {"kind": "grpc", "port": 80}}}`, "healthcheck kind"},
		{"bad hc port", `{"appId": "a", "releaseId": "r1", "source": {"kind": "static"}, "build": {"kind": "static"}, "run": {"image": "x:1", "healthcheck": {"kind": "http", "port": 0}}}`, "port"},
		{"bad prev name", `{"appId": "a", "releaseId": "r1", "source": {"kind": "static"}, "build": {"kind": "static"}, "run": {"image": "x:1"}, "prevContainer": {"name": "x y"}}`, "previous container"},
		{"keyfile space", `{"appId": "a", "releaseId": "r1", "source": {"kind": "git", "url": "https://git.example.com/a.git", "keyFile": "/a b"}, "build": {"kind": "dockerfile"}, "run": {}}`, "keyFile"},
		{"file url", `{"appId": "a", "releaseId": "r1", "source": {"kind": "git", "url": "file:///etc/passwd"}, "build": {"kind": "dockerfile"}, "run": {}}`, "git url"},
		{"dash url", `{"appId": "a", "releaseId": "r1", "source": {"kind": "git", "url": "-oProxyCommand=x"}, "build": {"kind": "dockerfile"}, "run": {}}`, "git url"},
		{"dash ref", `{"appId": "a", "releaseId": "r1", "source": {"kind": "git", "url": "https://git.example.com/a.git", "ref": "--upload-pack=evil"}, "build": {"kind": "dockerfile"}, "run": {}}`, "git ref"},
		{"subdir traversal", `{"appId": "a", "releaseId": "r1", "source": {"kind": "git", "url": "https://git.example.com/a.git", "subdir": "../escape"}, "build": {"kind": "dockerfile"}, "run": {}}`, "subdir"},
		{"abs dockerfile", `{"appId": "a", "releaseId": "r1", "source": {"kind": "git", "url": "https://git.example.com/a.git"}, "build": {"kind": "dockerfile", "dockerfile": "/etc/shadow"}, "run": {}}`, "dockerfile"},
		{"bad image ref", `{"appId": "a", "releaseId": "r1", "source": {"kind": "image", "url": "--privileged img"}, "build": {"kind": "image"}, "run": {}}`, "image"},
	}
	for _, c := range cases {
		_, err := ParseSpec(c.raw)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Fatalf("%s: want error containing %q, got %v", c.name, c.want, err)
		}
	}
}

func TestImageTagFoldsBadChars(t *testing.T) {
	s := &Spec{AppID: "My_App", ReleaseID: "r4 x"}
	if got := s.ImageTag(); got != "my_app:r4-x" {
		t.Fatalf("tag: %s", got)
	}
}
