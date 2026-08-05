package serve

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSnapshotWatchedTracksPlanningInputsWithoutGeneratedOutputs(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "index.go"), []byte("package fixture\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	planning := filepath.Join(root, ".planning")
	codebase := filepath.Join(planning, "codebase")
	if err := os.MkdirAll(codebase, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"STATE.md", "ROADMAP.md", "PROJECT.md", "DOMAIN.md", "DOMAIN-MODEL.md"} {
		if err := os.WriteFile(filepath.Join(planning, rel), []byte(rel+" v1\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, rel := range []string{"GROUPS.json", "FLOWS.json"} {
		if err := os.WriteFile(filepath.Join(codebase, rel), []byte("{}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, rel := range []string{"MAP.json", "MAP.html", "GRAPH_REPORT.md"} {
		if err := os.WriteFile(filepath.Join(codebase, rel), []byte(rel+" v1\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	before, err := snapshotWatched(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{
		".planning/STATE.md", ".planning/ROADMAP.md", ".planning/PROJECT.md",
		".planning/DOMAIN.md", ".planning/DOMAIN-MODEL.md",
		".planning/codebase/GROUPS.json", ".planning/codebase/FLOWS.json",
	} {
		if _, ok := before[filepath.FromSlash(rel)]; !ok {
			t.Errorf("planning source %s is not watched", rel)
		}
	}
	for _, rel := range []string{".planning/codebase/MAP.json", ".planning/codebase/MAP.html", ".planning/codebase/GRAPH_REPORT.md"} {
		if _, ok := before[filepath.FromSlash(rel)]; ok {
			t.Errorf("generated output %s is watched and can self-trigger", rel)
		}
	}

	for _, rel := range []string{"STATE.md", "PROJECT.md"} {
		t.Run(rel, func(t *testing.T) {
			if err := os.WriteFile(filepath.Join(planning, rel), []byte(rel+" changed and longer\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			after, err := snapshotWatched(root)
			if err != nil {
				t.Fatal(err)
			}
			if equalSnapshots(before, after) {
				t.Fatalf("editing .planning/%s did not change watched snapshot", rel)
			}
			before = after
		})
	}
}
