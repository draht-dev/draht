package container

import (
	"regexp"
	"strings"

	"github.com/draht-dev/draht/go/internal/model"
)

// defaultGroupTemplate is one DEFAULT_GROUPS literal entry
// (draht-tools.cjs:1119-1139).
type defaultGroupTemplate struct {
	ID          string
	Name        string
	Color       string
	Description string
	Members     []string
}

// defaultGroups is the verbatim DEFAULT_GROUPS table. Declaration order is
// load-bearing: it is both the exact-name-match scan order and the final
// groups[] emission order (empties dropped, group:other always last).
var defaultGroups = []defaultGroupTemplate{
	{
		ID: "group:frontend", Name: "Frontend", Color: "#79c0ff",
		Description: "User-facing web surfaces",
		Members:     []string{"@draht/web-ui", "@draht/landing"},
	},
	{
		ID: "group:cli-runtime", Name: "CLI & Runtime", Color: "#ffdf5d",
		Description: "Command-line tools and runtime gateways",
		Members:     []string{"draht-claude", "@draht/coding-agent", "@draht/tools", "@draht/tui", "@draht/gateway"},
	},
	{
		ID: "group:core", Name: "Core", Color: "#d2a8ff",
		Description: "Cross-cutting libraries used everywhere",
		Members:     []string{"@draht/ai", "@draht/agent-core", "@draht/router"},
	},
	{
		ID: "group:domain-services", Name: "Domain Services", Color: "#7ee787",
		Description: "Business logic and domain capabilities",
		Members:     []string{"@draht/mom", "@draht/knowledge", "@draht/orchestrator", "@draht/invoice", "@draht/compliance"},
	},
	{
		ID: "group:workflows-infra", Name: "Workflows & Infra", Color: "#f0883e",
		Description: "Build pipelines, deployment, templates, ops",
		Members:     []string{"@draht/ci", "@draht/deploy-guardian", "@draht/pods", "@draht/workflows", "@draht/infra", "@draht/templates"},
	},
	{
		ID: "group:root", Name: "Repo Root", Color: "#8b949e",
		Description: "Monorepo root package",
		Members:     []string{"draht-monorepo"},
	},
}

// groupFallbackRule is one FALLBACK_GROUP_RULES / PATH_GROUP_RULES entry.
type groupFallbackRule struct {
	ID string
	Re *regexp.Regexp
}

// fallbackGroupRules is the verbatim FALLBACK_GROUP_RULES table
// (draht-tools.cjs:1141-1147), evaluated in order against the scope-stripped,
// lower-cased container name.
var fallbackGroupRules = []groupFallbackRule{
	{ID: "group:frontend", Re: regexp.MustCompile(`^(web-ui|landing|ui|frontend|client|app|admin)$`)},
	{ID: "group:cli-runtime", Re: regexp.MustCompile(`^(cli|tui|gateway|coding|claude|tools|bin)|(?:^|-)extension(?:-|$)|^pi-`)},
	{ID: "group:core", Re: regexp.MustCompile(`^(ai|agent|router|llm|core|sdk|kernel)`)},
	{ID: "group:domain-services", Re: regexp.MustCompile(`^(mom|knowledge|orchestrator|invoice|compliance|chat|search|memory)`)},
	{ID: "group:workflows-infra", Re: regexp.MustCompile(`^(ci|deploy|pods|workflow|infra|template|guardian|ops)`)},
}

// pathGroupRules is the verbatim PATH_GROUP_RULES table
// (draht-tools.cjs:1150-1154), evaluated in order against the package's
// lower-cased relative path.
var pathGroupRules = []groupFallbackRule{
	{ID: "group:cli-runtime", Re: regexp.MustCompile(`(?:^|/)(examples?|extensions?|samples?)/`)},
	{ID: "group:frontend", Re: regexp.MustCompile(`(?:^|/)(apps?|web|frontend|client)/`)},
	{ID: "group:workflows-infra", Re: regexp.MustCompile(`(?:^|/)(scripts?|tools?|infra|deploy|ops)/`)},
}

// scopedNameRe strips an npm scope prefix ("@scope/") before the fallback
// regex scan, verbatim from draht-tools.cjs:1167.
var scopedNameRe = regexp.MustCompile(`^@[^/]+/`)

func indexOfDefaultGroup(id string) int {
	for i, g := range defaultGroups {
		if g.ID == id {
			return i
		}
	}
	return -1
}

func containsStr(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// maxGroupInheritanceDepth bounds the parent-package-inheritance recursion.
// The CJS source recurses unboundedly; a `startsWith(p.path + "/")` chain
// cannot actually cycle, but a defensive cap is cheap insurance (see the
// Phase 2 spec's risk note on this).
const maxGroupInheritanceDepth = 32

// findGroup mirrors the findGroup closure (draht-tools.cjs:1161-1204): an
// ordered cascade — exact-name membership, fallback name regex, parent-
// package inheritance, path regex, bin-presence cue, else otherGroup. The
// first matching rule wins; ties are impossible because rules are tried in a
// fixed, total order.
func findGroup(
	groups []*model.Group,
	otherGroup *model.Group,
	containerName string,
	pkg *model.Package,
	pkgs []model.Package,
	pkgHasBin func(pkgPath string) bool,
	depth int,
) *model.Group {
	for i, tmpl := range defaultGroups {
		if containsStr(tmpl.Members, containerName) {
			return groups[i]
		}
	}

	bare := strings.ToLower(scopedNameRe.ReplaceAllString(containerName, ""))
	for _, rule := range fallbackGroupRules {
		if rule.Re.MatchString(bare) {
			if idx := indexOfDefaultGroup(rule.ID); idx >= 0 {
				return groups[idx]
			}
		}
	}

	if pkg != nil && pkg.Path != "." && depth < maxGroupInheritanceDepth {
		var parent *model.Package
		for i := range pkgs {
			p := &pkgs[i]
			if p.Name == pkg.Name || p.Path == "." || p.Path == pkg.Path {
				continue
			}
			if strings.HasPrefix(pkg.Path, p.Path+"/") {
				parent = p
				break
			}
		}
		if parent != nil {
			parentGroup := findGroup(groups, otherGroup, parent.Name, parent, pkgs, pkgHasBin, depth+1)
			if parentGroup != nil && parentGroup.ID != "group:other" {
				return parentGroup
			}
		}
	}

	if pkg != nil && pkg.Path != "." {
		lowerPath := strings.ToLower(pkg.Path)
		for _, rule := range pathGroupRules {
			if rule.Re.MatchString(lowerPath) {
				if idx := indexOfDefaultGroup(rule.ID); idx >= 0 {
					return groups[idx]
				}
			}
		}
	}

	if pkg != nil && pkg.Path != "." && pkgHasBin != nil && pkgHasBin(pkg.Path) {
		if idx := indexOfDefaultGroup("group:cli-runtime"); idx >= 0 {
			return groups[idx]
		}
	}

	return otherGroup
}

// DeriveGroups partitions containers into functional groups, stamping
// containers[i].GroupID in place (containers MUST be the caller's live
// slice, not a copy — this mirrors the CJS `c.groupId = g.id` mutation).
// Verbatim port of deriveGroups (draht-tools.cjs:1156-1215).
//
// pkgHasBin probes whether the package at pkgPath (repo-relative) declares a
// truthy `bin` in its manifest — injected so this package performs no I/O
// (draht-tools.cjs:1193-1201 reads <root>/<pkgPath>/package.json directly).
//
// Order: DEFAULT_GROUPS declaration order, empty groups dropped, group:other
// appended last if non-empty. members[] order = containers order (the order
// containers are processed in, which callers MUST keep as BuildContainers'
// output order). No sort, no cap.
func DeriveGroups(containers []model.Container, pkgs []model.Package, pkgHasBin func(pkgPath string) bool) []model.Group {
	groups := make([]*model.Group, len(defaultGroups))
	for i, tmpl := range defaultGroups {
		groups[i] = &model.Group{
			ID:          tmpl.ID,
			Name:        tmpl.Name,
			Color:       tmpl.Color,
			Description: tmpl.Description,
			Members:     []string{},
			Source:      "auto",
			ModuleCount: 0,
		}
	}
	other := &model.Group{
		ID:          "group:other",
		Name:        "Other",
		Color:       "#8b949e",
		Description: "Packages not yet classified",
		Members:     []string{},
		Source:      "auto",
		ModuleCount: 0,
	}

	// pkgs.find(p => p.name === c.name) is a first-match lookup; build the
	// index keeping the FIRST package with a given name, not the last.
	pkgByName := make(map[string]*model.Package, len(pkgs))
	for i := range pkgs {
		p := &pkgs[i]
		if _, exists := pkgByName[p.Name]; !exists {
			pkgByName[p.Name] = p
		}
	}

	for i := range containers {
		c := &containers[i]
		pkg := pkgByName[c.Name]
		g := findGroup(groups, other, c.Name, pkg, pkgs, pkgHasBin, 0)
		g.Members = append(g.Members, c.ID)
		g.ModuleCount += c.ModuleCount
		c.GroupID = g.ID
	}

	var out []model.Group
	for _, g := range groups {
		if len(g.Members) > 0 {
			out = append(out, *g)
		}
	}
	if len(other.Members) > 0 {
		out = append(out, *other)
	}
	if out == nil {
		out = []model.Group{}
	}
	return out
}
