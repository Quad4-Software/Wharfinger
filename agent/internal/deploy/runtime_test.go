package deploy

import (
	"reflect"
	"testing"
)

// The binary name is injected so argv construction is verified
// without a real runtime on the test host.
func TestPullArgv(t *testing.T) {
	got := pullArgv("/usr/bin/podman", "docker.io/nginx:1.27")
	want := []string{"/usr/bin/podman", "pull", "docker.io/nginx:1.27"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestBuildArgv(t *testing.T) {
	got := buildArgv("/usr/bin/docker", "/state/src/app", "/state/src/app/Dockerfile",
		"app:r2", map[string]string{"B": "2", "A": "1"})
	want := []string{"/usr/bin/docker", "build", "-t", "app:r2",
		"-f", "/state/src/app/Dockerfile",
		"--build-arg", "A=1", "--build-arg", "B=2",
		"/state/src/app"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestBuildArgvNoDockerfileNoArgs(t *testing.T) {
	got := buildArgv("/usr/bin/podman", "/ctx", "", "app:r1", nil)
	want := []string{"/usr/bin/podman", "build", "-t", "app:r1", "/ctx"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestRunArgv(t *testing.T) {
	got := runArgv("/usr/bin/podman", RunOptions{
		Name:    "myapp-r3",
		Image:   "myapp:r3",
		EnvFile: "/state/env/myapp.env",
		Ports:   []Port{{Host: 8080, Container: 80}, {Host: 8443, Container: 443}},
	})
	want := []string{"/usr/bin/podman", "run", "-d", "--name", "myapp-r3",
		"--env-file", "/state/env/myapp.env",
		"-p", "8080:80", "-p", "8443:443",
		"--restart", "unless-stopped", "myapp:r3"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestRunArgvMinimal(t *testing.T) {
	got := runArgv("/usr/bin/docker", RunOptions{Name: "a-r1", Image: "a:r1"})
	want := []string{"/usr/bin/docker", "run", "-d", "--name", "a-r1",
		"--restart", "unless-stopped", "a:r1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestStopRmInspectLogsArgv(t *testing.T) {
	cases := []struct {
		got  []string
		want []string
	}{
		{stopArgv("/bin/docker", "a-r1", 10), []string{"/bin/docker", "stop", "-t", "10", "a-r1"}},
		{rmArgv("/bin/docker", "a-r1"), []string{"/bin/docker", "rm", "-f", "a-r1"}},
		{inspectArgv("/bin/podman", "a-r1"), []string{"/bin/podman", "inspect", "a-r1"}},
		{logsArgv("/bin/podman", "a-r1", 80), []string{"/bin/podman", "logs", "--tail", "80", "a-r1"}},
	}
	for i, c := range cases {
		if !reflect.DeepEqual(c.got, c.want) {
			t.Fatalf("case %d: got %v want %v", i, c.got, c.want)
		}
	}
}

func TestImageNamePodmanQualifiesShortNames(t *testing.T) {
	rt := &Runtime{Name: "podman"}
	cases := map[string]string{
		"nginx:1.27":              "docker.io/nginx:1.27",
		"library/nginx":           "docker.io/library/nginx",
		"docker.io/nginx:1.27":    "docker.io/nginx:1.27",
		"ghcr.io/org/app:1.0":     "ghcr.io/org/app:1.0",
		"localhost/app:2":         "localhost/app:2",
		"registry.local:5000/app": "registry.local:5000/app",
	}
	for in, want := range cases {
		if got := rt.imageName(in); got != want {
			t.Fatalf("imageName(%q) = %q, want %q", in, got, want)
		}
	}
	d := &Runtime{Name: "docker"}
	if got := d.imageName("nginx:1.27"); got != "nginx:1.27" {
		t.Fatalf("docker must not rewrite names, got %q", got)
	}
}

func TestParseInspect(t *testing.T) {
	raw := `[{
		"State": {
			"Status": "running",
			"Running": true,
			"ExitCode": 0,
			"Health": {"Status": "healthy"}
		},
		"RestartCount": 2,
		"NetworkSettings": {
			"IPAddress": "",
			"Networks": {"podman": {"IPAddress": "10.88.0.5"}}
		}
	}]`
	res, err := parseInspect(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Found || !res.Running || res.Health != "healthy" || res.RestartCount != 2 {
		t.Fatalf("bad inspect result: %+v", res)
	}
	if len(res.IPs) != 1 || res.IPs[0] != "10.88.0.5" {
		t.Fatalf("ips: %v", res.IPs)
	}
}

func TestParseInspectEmptyAndBad(t *testing.T) {
	res, err := parseInspect("[]")
	if err != nil || res.Found {
		t.Fatalf("empty inspect must be Found=false: %+v %v", res, err)
	}
	if _, err := parseInspect("not json"); err == nil {
		t.Fatal("bad json must error")
	}
}

func TestNotFound(t *testing.T) {
	for _, s := range []string{
		"Error: No such object: a-r1",
		"error: no container with name or ID 'a-r1' found",
	} {
		if !notFound(s) {
			t.Fatalf("missed not-found marker %q", s)
		}
	}
	for _, s := range []string{
		"permission denied",
		"a-r1: image not known",
		"Error response from daemon: driver failed",
	} {
		if notFound(s) {
			t.Fatalf("false positive on %q", s)
		}
	}
}

// ringBuf keeps bounded memory under unbounded writes.
func TestRingBuf(t *testing.T) {
	r := newRingBuf(8)
	_, _ = r.Write([]byte("0123456789ab"))
	if r.String() != "456789ab" {
		t.Fatalf("ring kept %q", r.String())
	}
	_, _ = r.Write([]byte("xy"))
	if r.String() != "6789abxy" {
		t.Fatalf("ring kept %q", r.String())
	}
}
