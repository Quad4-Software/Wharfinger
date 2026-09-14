package scan

import (
	"fmt"
	"strings"
	"testing"
)

var fixture = `{
	"Metadata": {"RepoDigests": ["registry.example.com/app@sha256:` +
	strings.Repeat("a", 64) + `"]},
	"Results": [{
		"Target": "app",
		"Vulnerabilities": [
			{
				"VulnerabilityID": "CVE-2024-0001",
				"PkgName": "openssl",
				"InstalledVersion": "3.0.0",
				"FixedVersion": "3.0.1",
				"Severity": "CRITICAL",
				"Title": "bad openssl bug",
				"CVSS": {"nvd": {"V3Score": 9.8}, "redhat": {"V3Score": 8.1}}
			},
			{
				"VulnerabilityID": "CVE-2024-0001",
				"PkgName": "openssl",
				"InstalledVersion": "3.0.0",
				"Severity": "CRITICAL",
				"Title": "duplicate row"
			},
			{
				"VulnerabilityID": "CVE-2024-0002",
				"PkgName": "musl",
				"InstalledVersion": "1.2.3",
				"Severity": "MEDIUM",
				"CVSS": {"nvd": {"V2Score": 4.3}}
			},
			{
				"VulnerabilityID": "CVE-2024-0003",
				"PkgName": "zlib",
				"Severity": "not-a-severity"
			},
			{
				"VulnerabilityID": "",
				"PkgName": "skipped",
				"Severity": "HIGH"
			}
		]
	}]
}`

func TestParseReport(t *testing.T) {
	res, err := ParseReport([]byte(fixture), "scan_1", 100)
	if err != nil {
		t.Fatal(err)
	}
	if res.ScanID != "scan_1" {
		t.Fatalf("scan id: %q", res.ScanID)
	}
	// The duplicate CVE-2024-0001/openssl row and the row with an
	// empty vuln id must not land.
	if len(res.Findings) != 3 {
		t.Fatalf("findings: got %d want 3", len(res.Findings))
	}
	if res.Summary.Critical != 1 || res.Summary.Medium != 1 || res.Summary.Unknown != 1 {
		t.Fatalf("summary: %+v", res.Summary)
	}
	first := res.Findings[0]
	if first.VulnID != "CVE-2024-0001" || first.Severity != "critical" {
		t.Fatalf("severity-first sort: %+v", first)
	}
	if first.CVSS != 9.8 {
		t.Fatalf("cvss picks max v3: %v", first.CVSS)
	}
	if res.Findings[1].CVSS != 4.3 {
		t.Fatalf("cvss v2 fallback: %v", res.Findings[1].CVSS)
	}
	if len(res.RepoDigests) != 1 {
		t.Fatalf("repo digests: %+v", res.RepoDigests)
	}
}

func TestParseReportCap(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"Results":[{"Vulnerabilities":[`)
	for i := 0; i < 50; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, `{"VulnerabilityID":"CVE-%d","PkgName":"p%d","Severity":"LOW"}`, i, i)
	}
	b.WriteString(`]}]}`)
	res, err := ParseReport([]byte(b.String()), "s", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Findings) != 10 {
		t.Fatalf("cap: got %d want 10", len(res.Findings))
	}
	// Summary still counts everything seen, truncation only bounds
	// what is shipped.
	if res.Summary.Low != 50 {
		t.Fatalf("summary under cap: %+v", res.Summary)
	}
}

func TestParseReportBadJSON(t *testing.T) {
	if _, err := ParseReport([]byte("{nope"), "s", 10); err == nil {
		t.Fatal("expected error")
	}
}

func TestParseSpec(t *testing.T) {
	s, err := ParseSpec(`{"scanId":"scan_abc","appId":"app_1","imageRef":"registry.io/x:1.2"}`)
	if err != nil {
		t.Fatal(err)
	}
	if s.ImageRef != "registry.io/x:1.2" {
		t.Fatalf("image ref: %q", s.ImageRef)
	}
	for _, bad := range []string{
		`{"scanId":"scan_abc","appId":"app_1","imageRef":"img; rm -rf /"}`,
		`{"scanId":"","appId":"app_1","imageRef":"img:1"}`,
		`{"scanId":"scan_abc","appId":"app_1","imageRef":""}`,
		`not json`,
	} {
		if _, err := ParseSpec(bad); err == nil {
			t.Fatalf("spec %q should fail", bad)
		}
	}
}
