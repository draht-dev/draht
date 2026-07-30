package emit

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

func TestWriteOutputs_JSONChanged_WritesReportAndHTML(t *testing.T) {
	dir := t.TempDir()
	m := model.NewMap()
	m.Root = "fixture"

	res, err := WriteOutputs(dir, m, true, false)
	if err != nil {
		t.Fatalf("WriteOutputs: %v", err)
	}
	if res.Unchanged {
		t.Errorf("res.Unchanged = true, want false (jsonChanged was true)")
	}
	if _, err := os.Stat(filepath.Join(dir, "GRAPH_REPORT.md")); err != nil {
		t.Errorf("expected GRAPH_REPORT.md to be written: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "MAP.html")); err != nil {
		t.Errorf("expected MAP.html to be written: %v", err)
	}
}

func TestWriteOutputs_JSONUnchanged_SkipsReportButStillWritesHTML(t *testing.T) {
	dir := t.TempDir()
	m := model.NewMap()
	m.Root = "fixture"

	res, err := WriteOutputs(dir, m, false, false)
	if err != nil {
		t.Fatalf("WriteOutputs: %v", err)
	}
	if !res.Unchanged {
		t.Errorf("res.Unchanged = false, want true (jsonChanged was false)")
	}
	if _, err := os.Stat(filepath.Join(dir, "GRAPH_REPORT.md")); !os.IsNotExist(err) {
		t.Errorf("expected GRAPH_REPORT.md to be absent when jsonChanged=false, stat err=%v", err)
	}
	// MAP.html is a derived view artifact: always refreshed on a non-quiet
	// build regardless of whether MAP.json changed.
	if _, err := os.Stat(filepath.Join(dir, "MAP.html")); err != nil {
		t.Errorf("expected MAP.html to still be written when jsonChanged=false: %v", err)
	}
}

func TestWriteOutputs_Quiet_SkipsHTML(t *testing.T) {
	dir := t.TempDir()
	m := model.NewMap()
	m.Root = "fixture"

	if _, err := WriteOutputs(dir, m, true, true); err != nil {
		t.Fatalf("WriteOutputs: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "GRAPH_REPORT.md")); err != nil {
		t.Errorf("expected GRAPH_REPORT.md to still be written under --quiet: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "MAP.html")); !os.IsNotExist(err) {
		t.Errorf("expected MAP.html to be skipped under --quiet, stat err=%v", err)
	}
}

// TestWriteOutputs_ReportDeletedWithUnchangedJSON_IsNotRegenerated locks in
// the deliberate CJS quirk (parity notes #27/#29): a GRAPH_REPORT.md deleted
// out-of-band, with MAP.json unchanged, stays deleted rather than being
// silently regenerated. Do not "fix" this.
func TestWriteOutputs_ReportDeletedWithUnchangedJSON_IsNotRegenerated(t *testing.T) {
	dir := t.TempDir()
	m := model.NewMap()
	m.Root = "fixture"

	if _, err := WriteOutputs(dir, m, true, false); err != nil {
		t.Fatalf("initial WriteOutputs: %v", err)
	}
	reportPath := filepath.Join(dir, "GRAPH_REPORT.md")
	if err := os.Remove(reportPath); err != nil {
		t.Fatalf("remove report: %v", err)
	}

	if _, err := WriteOutputs(dir, m, false, false); err != nil {
		t.Fatalf("second WriteOutputs: %v", err)
	}
	if _, err := os.Stat(reportPath); !os.IsNotExist(err) {
		t.Errorf("expected deleted GRAPH_REPORT.md to stay absent when jsonChanged=false, stat err=%v", err)
	}
}

func TestWriteOutputs_ResultPaths(t *testing.T) {
	dir := t.TempDir()
	m := model.NewMap()
	m.Root = "fixture"

	res, err := WriteOutputs(dir, m, true, false)
	if err != nil {
		t.Fatalf("WriteOutputs: %v", err)
	}
	if got, want := res.JSONPath, filepath.Join(dir, "MAP.json"); got != want {
		t.Errorf("JSONPath = %q, want %q", got, want)
	}
	if got, want := res.HTMLPath, filepath.Join(dir, "MAP.html"); got != want {
		t.Errorf("HTMLPath = %q, want %q", got, want)
	}
	if got, want := res.ReportPath, filepath.Join(dir, "GRAPH_REPORT.md"); got != want {
		t.Errorf("ReportPath = %q, want %q", got, want)
	}
}
