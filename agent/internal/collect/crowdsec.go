package collect

import (
	"encoding/json"
	"time"
)

// CrowdSec state comes from cscli, which the root-running agent can
// query directly. Both calls degrade to nil when cscli is absent.
type csDecision struct {
	Scope    string `json:"scope"`
	Value    string `json:"value"`
	Type     string `json:"type"`
	Scenario string `json:"scenario"`
}

type csAlert struct {
	Scenario string `json:"scenario"`
}

// parseCSDecisions maps `cscli decisions list -o json` into the capped
// ban sample. Only ban-type rows are shown; the count still covers
// every active decision.
func parseCSDecisions(data []byte) (int, []CSDecision) {
	var rows []csDecision
	if err := json.Unmarshal(data, &rows); err != nil {
		return 0, nil
	}
	var bans []CSDecision
	for _, r := range rows {
		if r.Type == "ban" && len(bans) < 100 {
			bans = append(bans, CSDecision{
				Scope:    r.Scope,
				Value:    r.Value,
				Type:     r.Type,
				Scenario: r.Scenario,
			})
		}
	}
	return len(rows), bans
}

func crowdsecStatus() *CrowdSec {
	b, err := runCmd(4*time.Second, "cscli", "decisions", "list", "-o", "json")
	if err != nil {
		return nil // absent, not running, or not permitted
	}
	cs := &CrowdSec{Enabled: true}
	cs.Decisions, cs.Bans = parseCSDecisions(b)
	if ab, err := runCmd(4*time.Second, "cscli", "alerts", "list", "-o", "json"); err == nil {
		var alerts []csAlert
		if json.Unmarshal(ab, &alerts) == nil {
			cs.Alerts = len(alerts)
		}
	}
	return cs
}
