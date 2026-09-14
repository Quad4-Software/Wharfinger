package deploy

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"time"
)

// Step names recorded in the journal. The journal is written BEFORE
// each step runs, so on an agent crash the last entry is the step
// that may have partially executed; Reconcile maps it to an outcome.
const (
	StepFetch    = "fetch"
	StepBuild    = "build"
	StepRun      = "run"
	StepHealth   = "healthcheck"
	StepStopPrev = "stopping_prev"
	// StepPublish is the static-path commit point: journaled right
	// after the atomic symlink swap, so reconcile treats it as done.
	StepPublish = "publish"
	StepSucceed = "succeed"
	StepFailed  = "failed"
)

// JournalEntry is the persisted state of one in-flight job. Runtime
// records which CLI ran the job so reconcile inspects the container
// on the same runtime it was created on.
type JournalEntry struct {
	JobID     int64  `json:"jobId"`
	Lease     string `json:"lease"`
	Step      string `json:"step"`
	Runtime   string `json:"runtime,omitempty"`
	Container string `json:"container,omitempty"`
	// Namespace is the k8s namespace the deployment lives in; empty
	// on container-runtime jobs.
	Namespace string `json:"namespace,omitempty"`
	Prev      string `json:"prev,omitempty"`
	ReleaseID string `json:"releaseId,omitempty"`
	Image     string `json:"image,omitempty"`
	Error     string `json:"error,omitempty"`
	UpdatedAt int64  `json:"updatedAt"`
}

// Journal persists one file per job under <stateDir>/jobs so a
// restart can report what was in flight.
type Journal struct {
	dir string
}

func NewJournal(stateDir string) *Journal {
	return &Journal{dir: filepath.Join(stateDir, "jobs")}
}

func (j *Journal) path(id int64) string {
	return filepath.Join(j.dir, strconv.FormatInt(id, 10)+".json")
}

// Save writes the entry atomically (write-then-rename, same pattern
// as the hub key pin) so a crash mid-write cannot leave a torn file.
func (j *Journal) Save(e JournalEntry) error {
	if err := os.MkdirAll(j.dir, 0o700); err != nil {
		return err
	}
	e.UpdatedAt = time.Now().UnixMilli()
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	final := j.path(e.JobID)
	tmp := final + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return fmt.Errorf("journal %d: %w", e.JobID, err)
	}
	if err := os.Rename(tmp, final); err != nil {
		return fmt.Errorf("journal %d: %w", e.JobID, err)
	}
	return nil
}

// Remove drops a finished entry. Missing files are fine: the job may
// never have journaled past its first step.
func (j *Journal) Remove(id int64) error {
	err := os.Remove(j.path(id))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// Entries returns every journaled job, oldest first. Corrupt files
// are skipped rather than failing startup reconciliation.
func (j *Journal) Entries() ([]JournalEntry, error) {
	des, err := os.ReadDir(j.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []JournalEntry
	for _, de := range des {
		if de.IsDir() || filepath.Ext(de.Name()) != ".json" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(j.dir, de.Name()))
		if err != nil {
			continue
		}
		var e JournalEntry
		if err := json.Unmarshal(b, &e); err != nil || e.JobID <= 0 {
			continue
		}
		out = append(out, e)
	}
	sort.Slice(out, func(a, b int) bool { return out[a].JobID < out[b].JobID })
	return out, nil
}
