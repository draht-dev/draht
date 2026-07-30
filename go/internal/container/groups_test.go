package container

import (
	"reflect"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

func containersFor(names ...string) []model.Container {
	out := make([]model.Container, len(names))
	for i, n := range names {
		out[i] = model.Container{ID: "pkg:" + n, Name: n, ModuleCount: i + 1}
	}
	return out
}

func TestDeriveGroups_ExactNameMatch(t *testing.T) {
	containers := containersFor("@draht/ai", "@draht/web-ui")
	pkgs := []model.Package{
		{Name: "@draht/ai", Path: "packages/ai"},
		{Name: "@draht/web-ui", Path: "packages/web-ui"},
	}
	groups := DeriveGroups(containers, pkgs, nil)

	// Declaration order: frontend before core, since frontend is declared
	// first in DEFAULT_GROUPS even though @draht/ai container comes first
	// in `containers`.
	if len(groups) != 2 {
		t.Fatalf("len(groups) = %d, want 2: %+v", len(groups), groups)
	}
	if groups[0].ID != "group:frontend" || groups[1].ID != "group:core" {
		t.Fatalf("groups order = %v, want [group:frontend, group:core]", groupIDs(groups))
	}
	if !reflect.DeepEqual(groups[0].Members, []string{"pkg:@draht/web-ui"}) {
		t.Fatalf("frontend members = %v", groups[0].Members)
	}
	if !reflect.DeepEqual(groups[1].Members, []string{"pkg:@draht/ai"}) {
		t.Fatalf("core members = %v", groups[1].Members)
	}
	// containers[i].GroupID must be stamped in place.
	if containers[0].GroupID != "group:core" || containers[1].GroupID != "group:frontend" {
		t.Fatalf("containers not stamped: %+v", containers)
	}
}

func TestDeriveGroups_FallbackNameRegex(t *testing.T) {
	// "tui-extra" bare-name (scope-stripped, lowercased) does not exactly
	// match any DEFAULT_GROUPS member, but the cli-runtime fallback regex's
	// first alternative `^(cli|tui|...)` is anchored at the START of the
	// bare name, which "tui-extra" satisfies.
	containers := containersFor("tui-extra")
	pkgs := []model.Package{{Name: "tui-extra", Path: "packages/tui-extra"}}
	groups := DeriveGroups(containers, pkgs, nil)
	if len(groups) != 1 || groups[0].ID != "group:cli-runtime" {
		t.Fatalf("groups = %v, want [group:cli-runtime]", groupIDs(groups))
	}
}

func TestDeriveGroups_FallbackNameRegex_UnanchoredMiddleDoesNotMatch(t *testing.T) {
	// The `^(cli|tui|...)` alternative is anchored — "tui" appearing mid-name
	// must NOT trigger the cli-runtime fallback (regression guard against a
	// naive "contains" port of the regex).
	containers := containersFor("mystery-tui-thing")
	pkgs := []model.Package{{Name: "mystery-tui-thing", Path: "packages/mystery"}}
	groups := DeriveGroups(containers, pkgs, nil)
	if len(groups) != 1 || groups[0].ID != "group:other" {
		t.Fatalf("groups = %v, want [group:other] (unanchored mid-string \"tui\" must not match)", groupIDs(groups))
	}
}

func TestDeriveGroups_ParentPackageInheritance(t *testing.T) {
	// packages/web-ui/example inherits from @draht/web-ui (parent by path
	// prefix), which resolves to group:frontend by exact-name match.
	containers := containersFor("draht-web-ui-example")
	pkgs := []model.Package{
		{Name: "@draht/web-ui", Path: "packages/web-ui"},
		{Name: "draht-web-ui-example", Path: "packages/web-ui/example"},
	}
	groups := DeriveGroups(containers, pkgs, nil)
	if len(groups) != 1 || groups[0].ID != "group:frontend" {
		t.Fatalf("groups = %v, want [group:frontend] via parent inheritance", groupIDs(groups))
	}
}

func TestDeriveGroups_PathRule(t *testing.T) {
	// A package whose name matches nothing, but whose path contains
	// "examples/" -> group:cli-runtime via PATH_GROUP_RULES.
	containers := containersFor("zzz-mystery")
	pkgs := []model.Package{{Name: "zzz-mystery", Path: "examples/zzz-mystery"}}
	groups := DeriveGroups(containers, pkgs, nil)
	if len(groups) != 1 || groups[0].ID != "group:cli-runtime" {
		t.Fatalf("groups = %v, want [group:cli-runtime] via path rule", groupIDs(groups))
	}
}

func TestDeriveGroups_BinCue(t *testing.T) {
	containers := containersFor("zzz-mystery")
	pkgs := []model.Package{{Name: "zzz-mystery", Path: "packages/mystery"}}
	groups := DeriveGroups(containers, pkgs, func(p string) bool { return p == "packages/mystery" })
	if len(groups) != 1 || groups[0].ID != "group:cli-runtime" {
		t.Fatalf("groups = %v, want [group:cli-runtime] via bin cue", groupIDs(groups))
	}
}

func TestDeriveGroups_OtherGroupIsLastAndOnlyWhenNonEmpty(t *testing.T) {
	containers := containersFor("totally-unclassifiable-zzz")
	pkgs := []model.Package{{Name: "totally-unclassifiable-zzz", Path: "packages/zzz"}}
	groups := DeriveGroups(containers, pkgs, nil)
	if len(groups) != 1 || groups[0].ID != "group:other" {
		t.Fatalf("groups = %v, want [group:other]", groupIDs(groups))
	}
	if groups[0].Name != "Other" || groups[0].Color != "#8b949e" {
		t.Fatalf("group:other shape wrong: %+v", groups[0])
	}
}

func TestDeriveGroups_EmptyGroupsDropped(t *testing.T) {
	// No containers at all -> every DEFAULT_GROUPS entry has 0 members and
	// must be dropped; group:other never appears (0 members).
	groups := DeriveGroups(nil, nil, nil)
	if len(groups) != 0 {
		t.Fatalf("groups = %v, want []", groupIDs(groups))
	}
}

func TestDeriveGroups_ModuleCountIsSumOfMemberContainerModuleCounts(t *testing.T) {
	containers := containersFor("@draht/ai", "@draht/agent-core")
	containers[0].ModuleCount = 10
	containers[1].ModuleCount = 5
	pkgs := []model.Package{
		{Name: "@draht/ai", Path: "packages/ai"},
		{Name: "@draht/agent-core", Path: "packages/agent-core"},
	}
	groups := DeriveGroups(containers, pkgs, nil)
	if len(groups) != 1 || groups[0].ID != "group:core" {
		t.Fatalf("groups = %v, want [group:core]", groupIDs(groups))
	}
	if groups[0].ModuleCount != 15 {
		t.Fatalf("group:core moduleCount = %d, want 15", groups[0].ModuleCount)
	}
}

func TestDeriveGroups_Determinism(t *testing.T) {
	pkgs := []model.Package{
		{Name: "@draht/ai", Path: "packages/ai"},
		{Name: "@draht/web-ui", Path: "packages/web-ui"},
		{Name: "zzz-mystery", Path: "packages/zzz"},
	}
	run := func() []model.Group {
		containers := containersFor("@draht/ai", "@draht/web-ui", "zzz-mystery")
		return DeriveGroups(containers, pkgs, nil)
	}
	first := run()
	for i := 0; i < 20; i++ {
		next := run()
		if !reflect.DeepEqual(first, next) {
			t.Fatalf("DeriveGroups is not deterministic:\n%+v\nvs\n%+v", first, next)
		}
	}
}

func groupIDs(groups []model.Group) []string {
	out := make([]string, len(groups))
	for i, g := range groups {
		out[i] = g.ID
	}
	return out
}
