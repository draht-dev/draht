package model

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteIfChangedFirstWriteAlwaysChanges(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "MAP.json")
	m := NewMap()
	m.Root = "repo"

	changed, err := WriteIfChanged(path, m)
	if err != nil {
		t.Fatalf("WriteIfChanged: %v", err)
	}
	if !changed {
		t.Error("expected changed=true on first write")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected file to exist: %v", err)
	}
}

func TestWriteIfChangedNoOpsWhenOnlyVolatileFieldsDiffer(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "MAP.json")

	m1 := NewMap()
	m1.Root = "repo"
	m1.GeneratedAt = "2026-01-01T00:00:00.000Z"
	m1.BuildMs = 100
	if _, err := WriteIfChanged(path, m1); err != nil {
		t.Fatalf("first WriteIfChanged: %v", err)
	}
	firstBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}

	m2 := NewMap()
	m2.Root = "repo"
	m2.GeneratedAt = "2026-06-15T12:34:56.000Z" // different timestamp
	m2.BuildMs = 999                            // different build time
	changed, err := WriteIfChanged(path, m2)
	if err != nil {
		t.Fatalf("second WriteIfChanged: %v", err)
	}
	if changed {
		t.Error("expected changed=false when only generatedAt/buildMs differ")
	}
	secondBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(secondBytes) != string(firstBytes) {
		t.Error("expected the on-disk file to be untouched by a no-op write")
	}
}

func TestWriteIfChangedWritesWhenAModuleChanges(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "MAP.json")

	m1 := NewMap()
	m1.Root = "repo"
	if _, err := WriteIfChanged(path, m1); err != nil {
		t.Fatalf("first WriteIfChanged: %v", err)
	}

	m2 := NewMap()
	m2.Root = "repo"
	m2.Modules = append(m2.Modules, Module{ID: "a.ts", Path: "a.ts"})
	changed, err := WriteIfChanged(path, m2)
	if err != nil {
		t.Fatalf("second WriteIfChanged: %v", err)
	}
	if !changed {
		t.Error("expected changed=true when modules[] differs")
	}
}

func TestWriteIfChangedWritesWhenPriorFileCorrupt(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "MAP.json")
	if err := os.WriteFile(path, []byte("{not valid json"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	m := NewMap()
	m.Root = "repo"
	changed, err := WriteIfChanged(path, m)
	if err != nil {
		t.Fatalf("WriteIfChanged: %v", err)
	}
	if !changed {
		t.Error("expected changed=true when the prior file is corrupt")
	}
}

func TestWriteIfChangedCreatesMissingDir(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "codebase", "MAP.json")
	m := NewMap()
	m.Root = "repo"
	changed, err := WriteIfChanged(path, m)
	if err != nil {
		t.Fatalf("WriteIfChanged: %v", err)
	}
	if !changed {
		t.Error("expected changed=true on first write")
	}
}
