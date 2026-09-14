package scan

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Field caps mirror src/lib/shared/scan.ts; the hub re-checks every
// bound at ingest, these keep the wire payload small.
const (
	maxVulnID  = 64
	maxPkg     = 160
	maxVersion = 80
	maxTitle   = 200
)

// imageRE bounds the single argv position imageRef lands in. The hub
// validates too; the agent re-checks because a spec is only as
// trustworthy as the channel that carried it.
var imageRE = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,255}$`)

var nameRE = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)

// Spec is the frozen scan spec the hub bakes into a job.
type Spec struct {
	ScanID    string `json:"scanId"`
	AppID     string `json:"appId"`
	ImageRef  string `json:"imageRef"`
	ReleaseID string `json:"releaseId"`
}

// ParseSpec decodes and validates the spec string carried by a
// claimed job.
func ParseSpec(raw string) (*Spec, error) {
	var s Spec
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		return nil, fmt.Errorf("spec json: %w", err)
	}
	if !nameRE.MatchString(s.ScanID) {
		return nil, fmt.Errorf("scanId %q is not a valid name", s.ScanID)
	}
	if s.AppID != "" && !nameRE.MatchString(s.AppID) {
		return nil, fmt.Errorf("appId %q is not a valid name", s.AppID)
	}
	if !imageRE.MatchString(s.ImageRef) {
		return nil, fmt.Errorf("image reference %q is not safe", s.ImageRef)
	}
	return &s, nil
}

// Finding is one compact vulnerability row for the hub report.
type Finding struct {
	VulnID    string  `json:"vulnId"`
	Pkg       string  `json:"pkg"`
	Installed string  `json:"installed,omitempty"`
	Fixed     string  `json:"fixed,omitempty"`
	Severity  string  `json:"severity"`
	Title     string  `json:"title,omitempty"`
	CVSS      float64 `json:"cvss,omitempty"`
}

// Summary rolls findings up by severity.
type Summary struct {
	Critical int `json:"critical"`
	High     int `json:"high"`
	Medium   int `json:"medium"`
	Low      int `json:"low"`
	Unknown  int `json:"unknown"`
}

// Result is the job result posted on a successful scan.
type Result struct {
	ScanID      string    `json:"scanId"`
	Summary     Summary   `json:"summary"`
	Findings    []Finding `json:"findings"`
	RepoDigests []string  `json:"repoDigests,omitempty"`
}

// trivy JSON, only the fields the hub consumes.
type trivyDoc struct {
	Results []struct {
		Vulnerabilities []struct {
			VulnerabilityID  string `json:"VulnerabilityID"`
			PkgName          string `json:"PkgName"`
			InstalledVersion string `json:"InstalledVersion"`
			FixedVersion     string `json:"FixedVersion"`
			Severity         string `json:"Severity"`
			Title            string `json:"Title"`
			CVSS             map[string]struct {
				V2Score float64 `json:"V2Score"`
				V3Score float64 `json:"V3Score"`
			} `json:"CVSS"`
		} `json:"Vulnerabilities"`
	} `json:"Results"`
	Metadata struct {
		RepoDigests []string `json:"RepoDigests"`
	} `json:"Metadata"`
}

func clip(s string, max int) string {
	if len(s) > max {
		return s[:max]
	}
	return s
}

func normSeverity(s string) string {
	switch strings.ToLower(s) {
	case "critical":
		return "critical"
	case "high":
		return "high"
	case "medium":
		return "medium"
	case "low":
		return "low"
	default:
		return "unknown"
	}
}

func sevRank(s string) int {
	switch s {
	case "critical":
		return 0
	case "high":
		return 1
	case "medium":
		return 2
	case "low":
		return 3
	default:
		return 4
	}
}

// cvssScore picks the highest v3 score across vendors, falling back
// to v2 when no v3 vector exists.
func cvssScore(m map[string]struct {
	V2Score float64 `json:"V2Score"`
	V3Score float64 `json:"V3Score"`
}) float64 {
	var best float64
	for _, v := range m {
		if v.V3Score > best {
			best = v.V3Score
		}
	}
	if best > 0 {
		return best
	}
	for _, v := range m {
		if v.V2Score > best {
			best = v.V2Score
		}
	}
	return best
}

// ParseReport converts trivy --format json output into the compact
// result the hub stores. Findings dedupe on (vulnId, pkg), sort
// severity-first, and truncate at max so the worst findings survive
// the wire cap.
func ParseReport(data []byte, scanID string, max int) (*Result, error) {
	var doc trivyDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("json: %w", err)
	}
	res := &Result{ScanID: scanID}
	seen := make(map[string]struct{})
	for _, r := range doc.Results {
		for _, v := range r.Vulnerabilities {
			if v.VulnerabilityID == "" || v.PkgName == "" {
				continue
			}
			key := v.VulnerabilityID + " " + v.PkgName
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}
			f := Finding{
				VulnID:    clip(v.VulnerabilityID, maxVulnID),
				Pkg:       clip(v.PkgName, maxPkg),
				Installed: clip(v.InstalledVersion, maxVersion),
				Fixed:     clip(v.FixedVersion, maxVersion),
				Severity:  normSeverity(v.Severity),
				Title:     clip(v.Title, maxTitle),
				CVSS:      cvssScore(v.CVSS),
			}
			switch f.Severity {
			case "critical":
				res.Summary.Critical++
			case "high":
				res.Summary.High++
			case "medium":
				res.Summary.Medium++
			case "low":
				res.Summary.Low++
			default:
				res.Summary.Unknown++
			}
			res.Findings = append(res.Findings, f)
		}
	}
	sort.SliceStable(res.Findings, func(i, j int) bool {
		ri, rj := sevRank(res.Findings[i].Severity), sevRank(res.Findings[j].Severity)
		if ri != rj {
			return ri < rj
		}
		return res.Findings[i].Pkg < res.Findings[j].Pkg
	})
	if max > 0 && len(res.Findings) > max {
		res.Findings = res.Findings[:max]
	}
	for _, d := range doc.Metadata.RepoDigests {
		if len(res.RepoDigests) >= 8 {
			break
		}
		res.RepoDigests = append(res.RepoDigests, clip(d, 300))
	}
	return res, nil
}
