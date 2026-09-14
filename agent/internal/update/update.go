// Package update implements secure self-update from GitHub releases.
// Flow: fetch the latest release metadata, compare semver against the
// running version, download the arch binary and SHA256SUMS.txt over
// https, verify the checksum, and atomically replace the running
// executable. Every failure aborts with no partial state: the new
// binary only lands via rename after the checksum passes.
package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
)

// binaryName is the release asset name for this platform.
func binaryName() string { return "wharfinger-agent-linux-" + runtime.GOARCH }

// Apply checks for a newer release and, when one exists, downloads,
// verifies, and installs it over the running executable. It returns
// the installed tag, or "" when the running version is already
// current. The process must restart to run the new binary.
func Apply(ctx context.Context, current string) (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return apply(ctx, current, exe)
}

func apply(ctx context.Context, current, exe string) (string, error) {
	// Fail fast before any download when the binary cannot be
	// replaced at all.
	exe, err := checkExe(exe)
	if err != nil {
		return "", err
	}
	rel, err := latest(ctx)
	if err != nil {
		return "", err
	}
	if rel.TagName == "" {
		return "", fmt.Errorf("latest release has no tag_name")
	}
	if !newerThan(rel.TagName, current) {
		return "", nil
	}
	name := binaryName()
	var binURL, sumsURL string
	for _, a := range rel.Assets {
		switch a.Name {
		case name:
			binURL = a.URL
		case "SHA256SUMS.txt":
			sumsURL = a.URL
		}
	}
	if binURL == "" || sumsURL == "" {
		return "", fmt.Errorf("release %s lacks %s or SHA256SUMS.txt", rel.TagName, name)
	}
	sums, err := download(ctx, sumsURL, maxSums)
	if err != nil {
		return "", fmt.Errorf("checksums: %w", err)
	}
	bin, err := download(ctx, binURL, maxBin)
	if err != nil {
		return "", fmt.Errorf("binary: %w", err)
	}
	if err := verify(bin, sums, name); err != nil {
		return "", err
	}
	if err := install(exe, bin); err != nil {
		return "", err
	}
	return rel.TagName, nil
}

// newerThan reports whether tag is a strictly higher semver than cur.
// A leading v and any -pre/+build suffix are ignored, so a tag like
// v1.2.3-rc1 compares as 1.2.3 and never counts as newer than the
// same triple (conservative: prereleases do not trigger updates).
func newerThan(tag, cur string) bool {
	t, ok1 := parseSemver(tag)
	c, ok2 := parseSemver(cur)
	if !ok1 || !ok2 {
		return false
	}
	for i := range t {
		if t[i] != c[i] {
			return t[i] > c[i]
		}
	}
	return false
}

func parseSemver(s string) ([3]int, bool) {
	var v [3]int
	s = strings.TrimPrefix(strings.TrimSpace(s), "v")
	if i := strings.IndexAny(s, "-+"); i >= 0 {
		s = s[:i]
	}
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return v, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return v, false
		}
		v[i] = n
	}
	return v, true
}

// verify checks bin against the matching line of a SHA256SUMS.txt
// body in coreutils format: "<hex>  <name>" or "<hex> *<name>".
func verify(bin, sums []byte, name string) error {
	var want string
	for _, line := range strings.Split(string(sums), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		if strings.TrimPrefix(f[len(f)-1], "*") == name {
			want = f[0]
			break
		}
	}
	if want == "" {
		return fmt.Errorf("%s missing from SHA256SUMS.txt", name)
	}
	sum := sha256.Sum256(bin)
	if got := hex.EncodeToString(sum[:]); !strings.EqualFold(got, want) {
		return fmt.Errorf("checksum mismatch for %s", name)
	}
	return nil
}
