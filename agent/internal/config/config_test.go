package config

import (
	"os"
	"path/filepath"
	"testing"
)

func baseArgs() []string {
	return []string{"-hub", "https://status.example.com", "-token", "st_x"}
}

func TestStateDirFlagAndEnv(t *testing.T) {
	c, err := Load(append(baseArgs(), "-state-dir", "/tmp/agent-state"))
	if err != nil {
		t.Fatal(err)
	}
	if c.StateDir != "/tmp/agent-state" {
		t.Fatalf("state dir: %s", c.StateDir)
	}
	t.Setenv("WHARFINGER_AGENT_STATE", "/tmp/env-state")
	c, err = Load(append(baseArgs(), "-state-dir", "/tmp/agent-state"))
	if err != nil {
		t.Fatal(err)
	}
	if c.StateDir != "/tmp/env-state" {
		t.Fatalf("env must win over flag: %s", c.StateDir)
	}
}

func TestStateDirDefaultFollowsTokenFile(t *testing.T) {
	dir := t.TempDir()
	tok := filepath.Join(dir, "token")
	if err := os.WriteFile(tok, []byte("st_x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TOKEN_FILE", tok)
	c, err := Load([]string{"-hub", "https://status.example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if c.TokenFile != tok {
		t.Fatalf("token file: %s", c.TokenFile)
	}
	if len(c.StateDirCandidates) == 0 || c.StateDirCandidates[0] != dir {
		t.Fatalf("state dir candidates must lead with TOKEN_FILE dir: %v", c.StateDirCandidates)
	}
}

func TestStrictPermsAndKubeInsecure(t *testing.T) {
	c, err := Load(append(baseArgs(), "-strict-perms", "-kube-insecure"))
	if err != nil {
		t.Fatal(err)
	}
	if !c.StrictPerms || !c.KubeInsecure {
		t.Fatal("flags not parsed")
	}
	t.Setenv("WHARFINGER_STRICT_PERMS", "1")
	t.Setenv("WHARFINGER_KUBE_INSECURE", "true")
	c, err = Load(baseArgs())
	if err != nil {
		t.Fatal(err)
	}
	if !c.StrictPerms || !c.KubeInsecure {
		t.Fatal("env vars not applied")
	}
}
