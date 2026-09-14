// Package state manages the agent's on-disk state directory. Two
// files live there: agent.key, the ed25519 identity key the agent
// generates on first run and uses to prove possession during the
// handshake and on every metrics frame, and hub.key, the pinned hub
// public key that rotation proofs can replace. Both are owner-only
// files inside an owner-only directory.
package state

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const (
	identityFile = "agent.key"
	hubPinFile   = "hub.key"
)

// Store is a resolved state directory on disk.
type Store struct {
	dir string
}

// Open creates the state directory when missing and returns a handle.
// The directory is created with explicit owner-only permissions;
// permissions on a pre-existing directory are left untouched and
// reported by PermIssues instead of silently fixed.
func Open(dir string) (*Store, error) {
	if dir == "" {
		return nil, fmt.Errorf("state dir is empty")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("state dir %s: %w", dir, err)
	}
	return &Store{dir: dir}, nil
}

// OpenFirst tries each candidate in order and returns the first
// directory that exists (or can be created) and accepts a write. The
// default candidates include mounts that may be read-only (docker
// secrets dirs), so writability is probed, not assumed.
func OpenFirst(dirs []string) (*Store, error) {
	var errs []string
	for _, d := range dirs {
		st, err := Open(d)
		if err != nil {
			errs = append(errs, err.Error())
			continue
		}
		f, err := os.CreateTemp(d, ".probe-*")
		if err != nil {
			errs = append(errs, fmt.Sprintf("state dir %s not writable: %v", d, err))
			continue
		}
		_ = f.Close()
		_ = os.Remove(f.Name())
		return st, nil
	}
	return nil, fmt.Errorf("no writable state dir (set -state-dir): %s", strings.Join(errs, "; "))
}

// Dir returns the state directory path.
func (s *Store) Dir() string { return s.dir }

// IdentityPath is the agent identity key file, for permission checks.
func (s *Store) IdentityPath() string { return filepath.Join(s.dir, identityFile) }

// HubKeyPath is the pinned hub key file, for permission checks.
func (s *Store) HubKeyPath() string { return filepath.Join(s.dir, hubPinFile) }

// Identity returns the agent's ed25519 private key, generating and
// persisting one on first use. The file stores the base64 seed and is
// created O_EXCL so a racing process can never overwrite it; whoever
// loses the race reads the winner's key.
func (s *Store) Identity() (ed25519.PrivateKey, error) {
	path := s.IdentityPath()
	if priv, err := readIdentity(path); err == nil {
		return priv, nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate agent key: %w", err)
	}
	seed := make([]byte, ed25519.SeedSize)
	copy(seed, priv.Seed())
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if errors.Is(err, fs.ErrExist) {
			return readIdentity(path)
		}
		return nil, fmt.Errorf("write %s: %w", path, err)
	}
	if _, err := f.WriteString(base64.StdEncoding.EncodeToString(seed) + "\n"); err != nil {
		f.Close()
		return nil, fmt.Errorf("write %s: %w", path, err)
	}
	if err := f.Close(); err != nil {
		return nil, fmt.Errorf("write %s: %w", path, err)
	}
	return priv, nil
}

func readIdentity(path string) (ed25519.PrivateKey, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	seed, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(b)))
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("%s: corrupt agent key file", path)
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// HubPin returns the persisted pinned hub public key, or nil when no
// pin exists yet (first contact, before TOFU adoption).
func (s *Store) HubPin() (ed25519.PublicKey, error) {
	b, err := os.ReadFile(s.HubKeyPath())
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	pub, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(b)))
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("%s: corrupt hub key file", s.HubKeyPath())
	}
	return ed25519.PublicKey(pub), nil
}

// SaveHubPin persists the pinned hub key. Called on first seeding,
// TOFU adoption, and verified rotation. Write-then-rename keeps the
// old pin readable if the process dies mid-write.
func (s *Store) SaveHubPin(pub ed25519.PublicKey) error {
	if len(pub) != ed25519.PublicKeySize {
		return fmt.Errorf("hub key must be %d bytes", ed25519.PublicKeySize)
	}
	final := s.HubKeyPath()
	tmp := final + ".tmp"
	if err := os.WriteFile(tmp, []byte(base64.StdEncoding.EncodeToString(pub)+"\n"), 0o600); err != nil {
		return fmt.Errorf("write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, final); err != nil {
		return fmt.Errorf("rename %s: %w", final, err)
	}
	return nil
}
