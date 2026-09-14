package deploy

import (
	"os"
	"path/filepath"
	"testing"
)

func TestJournalRoundTrip(t *testing.T) {
	dir := t.TempDir()
	j := NewJournal(dir)

	e1 := JournalEntry{JobID: 7, Lease: "L1", Step: StepFetch, Container: "app-r1"}
	e2 := JournalEntry{JobID: 3, Lease: "L2", Step: StepHealth, Container: "app-r2", Prev: "app-r1"}
	if err := j.Save(e1); err != nil {
		t.Fatal(err)
	}
	if err := j.Save(e2); err != nil {
		t.Fatal(err)
	}

	entries, err := j.Entries()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries: %v", entries)
	}
	// Sorted by job id so reconcile reports are deterministic.
	if entries[0].JobID != 3 || entries[1].JobID != 7 {
		t.Fatalf("order: %v", entries)
	}
	if entries[0].Prev != "app-r1" || entries[0].UpdatedAt == 0 {
		t.Fatalf("entry fields: %+v", entries[0])
	}
}

// A resume overwrites the same file: the last saved step is what a
// restart sees.
func TestJournalResume(t *testing.T) {
	dir := t.TempDir()
	j := NewJournal(dir)
	if err := j.Save(JournalEntry{JobID: 9, Lease: "L", Step: StepFetch}); err != nil {
		t.Fatal(err)
	}
	if err := j.Save(JournalEntry{JobID: 9, Lease: "L", Step: StepHealth, Container: "app-r9"}); err != nil {
		t.Fatal(err)
	}
	entries, err := j.Entries()
	if err != nil || len(entries) != 1 {
		t.Fatalf("entries: %v %v", entries, err)
	}
	if entries[0].Step != StepHealth || entries[0].Container != "app-r9" {
		t.Fatalf("resume entry: %+v", entries[0])
	}
}

func TestJournalRemoveAndCorrupt(t *testing.T) {
	dir := t.TempDir()
	j := NewJournal(dir)
	if err := j.Save(JournalEntry{JobID: 1, Step: StepFetch}); err != nil {
		t.Fatal(err)
	}
	// A torn write must be skipped, not fail reconciliation.
	if err := os.WriteFile(filepath.Join(j.dir, "2.json"), []byte("{bad"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Non-json files are ignored.
	if err := os.WriteFile(filepath.Join(j.dir, "note.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	entries, err := j.Entries()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].JobID != 1 {
		t.Fatalf("entries: %v", entries)
	}
	if err := j.Remove(1); err != nil {
		t.Fatal(err)
	}
	// Removing a missing entry is not an error.
	if err := j.Remove(1); err != nil {
		t.Fatal(err)
	}
	if entries, _ := j.Entries(); len(entries) != 0 {
		t.Fatalf("expected empty journal, got %v", entries)
	}
}

func TestJournalEmptyDir(t *testing.T) {
	j := NewJournal(filepath.Join(t.TempDir(), "missing"))
	entries, err := j.Entries()
	if err != nil || len(entries) != 0 {
		t.Fatalf("entries: %v %v", entries, err)
	}
}
