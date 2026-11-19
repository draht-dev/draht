package query

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

func symbolModule(path string, symbols ...model.Symbol) model.Module {
	return model.Module{ID: path, Path: path, Symbols: symbols}
}

func exportedSym(name, kind string) model.Symbol {
	return model.Symbol{Name: name, Kind: kind, Line: 1, Exported: true}
}

func queryHits(t *testing.T, m *model.Map, terms ...string) []QueryHit {
	t.Helper()
	var buf bytes.Buffer
	if code := Query(m, append(terms, "--json"), &buf); code != 0 {
		t.Fatalf("Query exit code = %d", code)
	}
	var hits []QueryHit
	if err := json.Unmarshal(buf.Bytes(), &hits); err != nil {
		t.Fatalf("decode %q: %v", buf.String(), err)
	}
	return hits
}

// TestQuery_BarrelDoesNotOutrankTheDefiningFile: the barrel's re-export symbol
// for a name used to match as strongly as the definition and, being the more
// connected module, win the tie. Re-export symbols are not scored; the
// defining module matches the name.
func TestQuery_BarrelDoesNotOutrankTheDefiningFile(t *testing.T) {
	m := model.NewMap()
	m.Modules = []model.Module{
		symbolModule("packages/core/src/index.ts", exportedSym("resolveWidget", "re-export")),
		symbolModule("packages/core/src/widget.ts", exportedSym("resolveWidget", "function")),
		symbolModule("packages/app/src/main.ts"),
		symbolModule("packages/cli/src/main.ts"),
	}
	m.Edges = []model.Edge{
		{From: "packages/app/src/main.ts", To: "packages/core/src/index.ts", Kind: "import"},
		{From: "packages/cli/src/main.ts", To: "packages/core/src/index.ts", Kind: "import"},
	}
	hits := queryHits(t, m, "resolvewidget")
	if len(hits) == 0 || hits[0].Path != "packages/core/src/widget.ts" {
		t.Fatalf("hits = %+v, want the defining file first", hits)
	}
	for _, h := range hits {
		if h.Path == "packages/core/src/index.ts" {
			t.Errorf("barrel matched through its re-export symbol: %+v", h)
		}
	}
}

// TestQuery_SingleSymbolSatisfyingEveryTermWins: a multi-term query that one
// declared symbol's name satisfies in full is a definition lookup and
// outranks a module that merely covers the terms with separate symbols.
func TestQuery_SingleSymbolSatisfyingEveryTermWins(t *testing.T) {
	m := model.NewMap()
	m.Modules = []model.Module{
		symbolModule("packages/core/src/alpha.ts", exportedSym("SessionStore", "class"), exportedSym("TokenBudget", "class")),
		symbolModule("packages/core/src/beta.ts", exportedSym("SessionToken", "interface")),
	}
	hits := queryHits(t, m, "session", "token")
	if len(hits) != 2 || hits[0].Path != "packages/core/src/beta.ts" {
		t.Fatalf("hits = %+v, want beta.ts (SessionToken) first", hits)
	}
	// A re-export copy of the full name does not trigger the bonus.
	m.Modules[0].Symbols = append(m.Modules[0].Symbols, exportedSym("SessionTokenCopy", "re-export"))
	hits = queryHits(t, m, "session", "token")
	if hits[0].Path != "packages/core/src/beta.ts" {
		t.Errorf("re-export symbol granted the definition bonus: %+v", hits)
	}
}
