package query

import (
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

func mkModule(id, path string) model.Module {
	return model.Module{ID: id, Path: path}
}

func TestResolver_ExactMatch(t *testing.T) {
	m := model.NewMap()
	m.Modules = []model.Module{mkModule("a/b/c.ts", "a/b/c.ts")}
	r := NewResolver(m)
	res := r.Resolve("a/b/c.ts")
	if res == nil || res.ID != "a/b/c.ts" || !res.Exact {
		t.Fatalf("Resolve exact = %+v", res)
	}
}

func TestResolver_LeadingDotSlashStripped(t *testing.T) {
	m := model.NewMap()
	m.Modules = []model.Module{mkModule("a/b/c.ts", "a/b/c.ts")}
	r := NewResolver(m)
	res := r.Resolve("./a/b/c.ts")
	if res == nil || res.ID != "a/b/c.ts" || !res.Exact {
		t.Fatalf("Resolve ./-prefixed = %+v", res)
	}
}

// TestResolver_AbsolutePathIsNotSpecialCased documents that graphResolveFile
// never normalizes an absolute path (no leading-slash stripping, unlike the
// "./" case) — it is passed through verbatim into the same 4-stage cascade
// as any other query. On a real, large MAP.json this means an absolute path
// almost always resolves to nil (its basename is ambiguous, and no module
// id contains the entire absolute string) — see golden case context_abs.
// But because there is no explicit "reject absolute paths" branch, a
// pathological single-module (or basename-unique) map WILL still resolve
// an absolute path via the basename fallback stage; verified byte-for-byte
// against the CJS via `node -e` with this exact module list.
func TestResolver_AbsolutePathIsNotSpecialCased(t *testing.T) {
	m := model.NewMap()
	m.Modules = []model.Module{mkModule("a/b/c.ts", "a/b/c.ts")}
	r := NewResolver(m)
	res := r.Resolve("/repo/a/b/c.ts")
	if res == nil || res.ID != "a/b/c.ts" || res.Exact {
		t.Fatalf("Resolve absolute path = %+v, want {a/b/c.ts false} (basename-fallback match, confirmed against the CJS)", res)
	}
}

func TestResolver_UniqueSuffix(t *testing.T) {
	m := model.NewMap()
	m.Modules = []model.Module{
		mkModule("pkg/src/nodejs.ts", "pkg/src/nodejs.ts"),
		mkModule("pkg/other.ts", "pkg/other.ts"),
	}
	r := NewResolver(m)
	res := r.Resolve("nodejs.ts")
	if res == nil || res.ID != "pkg/src/nodejs.ts" || res.Exact {
		t.Fatalf("Resolve suffix = %+v", res)
	}
}

func TestResolver_AmbiguousSuffixFallsThroughToBasename(t *testing.T) {
	m := model.NewMap()
	m.Modules = []model.Module{
		mkModule("pkg1/types.ts", "pkg1/types.ts"),
		mkModule("pkg2/types.ts", "pkg2/types.ts"),
	}
	r := NewResolver(m)
	res := r.Resolve("types.ts")
	// Both suffix stage AND basename stage are ambiguous (2 matches each),
	// so this falls all the way through to the substring stage, which picks
	// the shortest id (both are equal length here -> first in modules order).
	if res == nil || res.ID != "pkg1/types.ts" || res.Exact {
		t.Fatalf("Resolve ambiguous = %+v", res)
	}
}

func TestResolver_SubstringShortestWins(t *testing.T) {
	m := model.NewMap()
	m.Modules = []model.Module{
		mkModule("packages/ai/src/cli.ts", "packages/ai/src/cli.ts"),
		mkModule("packages/ai/scripts/generate-models.ts", "packages/ai/scripts/generate-models.ts"),
	}
	r := NewResolver(m)
	res := r.Resolve("packages/ai")
	if res == nil || res.ID != "packages/ai/src/cli.ts" || res.Exact {
		t.Fatalf("Resolve substring = %+v, want shortest id packages/ai/src/cli.ts", res)
	}
}

func TestResolver_SubstringTieBreak_FirstInModulesOrderWins(t *testing.T) {
	m := model.NewMap()
	// Two ids of EQUAL length both containing "x" — the first one in
	// map.modules order must win (stable sort by length, then [0]).
	m.Modules = []model.Module{
		mkModule("bbbx.ts", "bbbx.ts"),
		mkModule("aaax.ts", "aaax.ts"),
	}
	r := NewResolver(m)
	res := r.Resolve("x")
	if res == nil || res.ID != "bbbx.ts" {
		t.Fatalf("Resolve tie-break = %+v, want first-in-order bbbx.ts", res)
	}
}

func TestResolver_NoMatch(t *testing.T) {
	m := model.NewMap()
	m.Modules = []model.Module{mkModule("a.ts", "a.ts")}
	r := NewResolver(m)
	if res := r.Resolve("does-not-exist.ts"); res != nil {
		t.Fatalf("Resolve no-match = %+v, want nil", res)
	}
}

func TestResolver_EmptyQuery(t *testing.T) {
	m := model.NewMap()
	m.Modules = []model.Module{mkModule("a.ts", "a.ts")}
	r := NewResolver(m)
	if res := r.Resolve(""); res != nil {
		t.Fatalf("Resolve empty = %+v, want nil", res)
	}
}
