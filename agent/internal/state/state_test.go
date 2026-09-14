package state

import (
	"bytes"
	"crypto/ed25519"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenCreatesDirOwnerOnly(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(st.Dir())
	if err != nil {
		t.Fatal(err)
	}
	if !fi.IsDir() {
		t.Fatal("state dir is not a directory")
	}
	if fi.Mode().Perm()&0o077 != 0 {
		t.Fatalf("state dir mode %o is group/other accessible", fi.Mode().Perm())
	}
}

func TestIdentityGeneratesAndPersists(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	id1, err := st.Identity()
	if err != nil {
		t.Fatal(err)
	}
	if len(id1) != ed25519.PrivateKeySize {
		t.Fatalf("identity key size %d", len(id1))
	}
	fi, err := os.Stat(st.IdentityPath())
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm()&0o077 != 0 {
		t.Fatalf("agent.key mode %o is group/other accessible", fi.Mode().Perm())
	}
	// Second call returns the same key.
	id2, err := st.Identity()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(id1, id2) {
		t.Fatal("identity not stable across reads")
	}
	// A fresh store on the same dir loads the persisted key.
	st2, err := Open(st.Dir())
	if err != nil {
		t.Fatal(err)
	}
	id3, err := st2.Identity()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(id1, id3) {
		t.Fatal("identity not stable across store instances")
	}
}

func TestIdentityRejectsCorruptFile(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(st.IdentityPath(), []byte("not-base64!!!"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Identity(); err == nil {
		t.Fatal("corrupt agent.key must fail, not silently regenerate")
	}
}

func TestHubPinRoundtrip(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if pin, err := st.HubPin(); err != nil || pin != nil {
		t.Fatalf("empty pin: got %v err %v", pin, err)
	}
	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SaveHubPin(pub); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(st.HubKeyPath())
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm()&0o077 != 0 {
		t.Fatalf("hub.key mode %o is group/other accessible", fi.Mode().Perm())
	}
	got, err := st.HubPin()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, pub) {
		t.Fatal("hub pin roundtrip mismatch")
	}
}

func TestOpenFirstSkipsUnusableDirs(t *testing.T) {
	base := t.TempDir()
	// A regular file passed as a dir candidate fails reliably on any
	// platform (MkdirAll gets ENOTDIR), standing in for a read-only
	// mount without needing chmod tricks.
	file := filepath.Join(base, "afile")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	good := filepath.Join(base, "good")
	st, err := OpenFirst([]string{file, good})
	if err != nil {
		t.Fatal(err)
	}
	if st.Dir() != good {
		t.Fatalf("expected fallback to %s, got %s", good, st.Dir())
	}
	// All candidates bad: clear error.
	if _, err := OpenFirst([]string{file}); err == nil {
		t.Fatal("expected error when no candidate is usable")
	}
}

func TestPermIssues(t *testing.T) {
	dir := t.TempDir()
	open := filepath.Join(dir, "open")
	if err := os.WriteFile(open, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	locked := filepath.Join(dir, "locked")
	if err := os.WriteFile(locked, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(dir, "missing")
	issues := PermIssues(open, locked, missing, "")
	if len(issues) != 1 {
		t.Fatalf("expected 1 issue, got %v", issues)
	}
	// Group-executable dir is also flagged.
	openDir := filepath.Join(dir, "opendir")
	if err := os.Mkdir(openDir, 0o750); err != nil {
		t.Fatal(err)
	}
	if got := PermIssues(openDir); len(got) != 1 {
		t.Fatalf("expected dir issue, got %v", got)
	}
}
