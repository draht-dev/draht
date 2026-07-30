package query

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/scan"
)

// NoMapMessage is the exact single line printed by every graph-* command
// (graphNoMap, draht-tools.cjs:5341) when no MAP.json is loadable. The
// dispatcher must print this and return exit 0 BEFORE any argument
// validation — the CJS checks `if (!map) return graphNoMap()` first, so a
// missing map takes priority even over a missing/invalid usage.
const NoMapMessage = "no map — run `draht-tools map-graph` first."

// FindRepoRoot ports findRepoRoot (draht-tools.cjs:91-111) by delegating to
// internal/scan's existing verbatim port. Any resolution failure (only
// possible from a pathological cwd) falls back to start itself, mirroring
// the CJS's guaranteed-to-return-a-string contract.
func FindRepoRoot(start string) string {
	root, err := scan.FindRepoRoot(start)
	if err != nil {
		return start
	}
	return root
}

// LoadMap ports graphLoadMap (draht-tools.cjs:5335-5340): read and parse
// <repoRoot>/.planning/codebase/MAP.json. Any failure — missing file,
// unreadable, malformed JSON — returns (nil, nil), NOT an error, exactly
// like the CJS's try/catch collapsing every failure mode to `map: null`.
// Callers use a nil map to emit NoMapMessage. An error is returned only for
// a programmer error (empty repoRoot), which the CJS cannot express (it
// always has a resolved cwd).
func LoadMap(repoRoot string) (*model.Map, error) {
	if repoRoot == "" {
		return nil, errors.New("query: LoadMap: repoRoot must not be empty")
	}
	path := filepath.Join(repoRoot, scan.PlanningDir, "codebase", "MAP.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, nil
	}
	var m model.Map
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, nil
	}
	return &m, nil
}
