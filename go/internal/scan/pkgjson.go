package scan

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// BinEntry is one package.json "bin" entry (string form or object form).
// The string form `"bin": "cli.js"` expands to a single entry whose Name is
// the package name.
type BinEntry struct {
	Name string
	File string
}

// Package carries the manifest fields the graph pipeline needs, so graph
// never re-reads package.json itself.
type Package struct {
	Name        string
	Path        string
	Version     *string
	Description *string

	// Dependencies/DevDependencies/PeerDependencies preserve manifest key
	// order (see OrderedObjectKeys).
	Dependencies      []string
	DevDependencies   []string
	PeerDependencies  []string
	WorkspaceDeps     []string
	WorkspacePatterns []string // root manifest only

	// Raw manifest fields, consumed by graph for entry-point resolution.
	Bin          []BinEntry
	Main, Module string
	ExportLeaves []string // every string leaf of pj.exports, Object.values() order
}

// OrderedObjectKeys extracts the top-level key order of a JSON object.
// encoding/json's map decoding loses key order; packages[].dependencies and
// ExportLeaves MUST reproduce manifest / Object.values() order.
func OrderedObjectKeys(raw []byte) ([]string, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return nil, fmt.Errorf("scan: read object token: %w", err)
	}
	delim, ok := tok.(json.Delim)
	if !ok || delim != '{' {
		return nil, fmt.Errorf("scan: expected a JSON object, got %v", tok)
	}

	var keys []string
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, fmt.Errorf("scan: read object key: %w", err)
		}
		key, ok := keyTok.(string)
		if !ok {
			return nil, fmt.Errorf("scan: expected a string key, got %v", keyTok)
		}
		keys = append(keys, key)

		// Skip the value without caring about its shape.
		var discard json.RawMessage
		if err := dec.Decode(&discard); err != nil {
			return nil, fmt.Errorf("scan: skip value for key %q: %w", key, err)
		}
	}
	return keys, nil
}

// collectStringLeaves walks a decoded JSON value (object, array, or scalar)
// in document order, appending every string leaf to out. Objects recurse
// over their values in key order; arrays recurse over elements in index
// order — matching JS `Object.values()` on either an object or an array, per
// visScanPackages' recursive `collect()` (draht-tools.cjs:2232-2237).
func collectStringLeaves(dec *json.Decoder, out *[]string) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	return collectStringLeavesValue(dec, tok, out)
}

func collectStringLeavesValue(dec *json.Decoder, tok json.Token, out *[]string) error {
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			for dec.More() {
				if _, err := dec.Token(); err != nil { // key, discarded
					return err
				}
				valTok, err := dec.Token()
				if err != nil {
					return err
				}
				if err := collectStringLeavesValue(dec, valTok, out); err != nil {
					return err
				}
			}
			_, err := dec.Token() // consume '}'
			return err
		case '[':
			for dec.More() {
				valTok, err := dec.Token()
				if err != nil {
					return err
				}
				if err := collectStringLeavesValue(dec, valTok, out); err != nil {
					return err
				}
			}
			_, err := dec.Token() // consume ']'
			return err
		}
	case string:
		*out = append(*out, t)
	}
	return nil
}

// exportLeavesFromRaw ports the `collect()` closure at
// draht-tools.cjs:2232-2237: every string leaf of pj.exports, in
// Object.values() document order.
func exportLeavesFromRaw(raw json.RawMessage) ([]string, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	var out []string
	if err := collectStringLeaves(dec, &out); err != nil {
		return nil, fmt.Errorf("scan: collect export leaves: %w", err)
	}
	return out, nil
}

// decodeDeps returns the manifest key order plus a name->version-string map
// for one dependency object ("dependencies", "devDependencies", or
// "peerDependencies"). A malformed object degrades to (nil, nil) rather than
// failing the whole manifest read, matching the CJS try/catch-per-manifest
// posture.
func decodeDeps(raw json.RawMessage) ([]string, map[string]string) {
	if len(raw) == 0 {
		return nil, nil
	}
	order, err := OrderedObjectKeys(raw)
	if err != nil {
		return nil, nil
	}
	var values map[string]string
	_ = json.Unmarshal(raw, &values) // best-effort; non-string values leave gaps
	return order, values
}

// parseBin ports the bin-entry expansion at draht-tools.cjs:2104-2114: a
// string bin collapses to a single entry named after the package; an object
// bin expands to one entry per key, in manifest key order.
func parseBin(raw json.RawMessage, pkgName string) []BinEntry {
	if len(raw) == 0 {
		return nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return []BinEntry{{Name: pkgName, File: s}}
	}

	order, err := OrderedObjectKeys(raw)
	if err != nil {
		return nil
	}
	var m map[string]string
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil
	}
	out := make([]BinEntry, 0, len(order))
	for _, name := range order {
		if file, ok := m[name]; ok {
			out = append(out, BinEntry{Name: name, File: file})
		}
	}
	return out
}

// pnpmPackagesHeaderRe / pnpmDashLineRe / pnpmItemRe are the hand-rolled
// pnpm-workspace.yaml line parser from visDiscoverWorkspacePatterns
// (draht-tools.cjs:1595-1612) — deliberately NOT a YAML library.
var (
	pnpmPackagesHeaderRe = regexp.MustCompile(`^packages\s*:\s*(?:#.*)?$`)
	pnpmDashLineRe       = regexp.MustCompile(`^\s*-`)
	pnpmNonIndentRe      = regexp.MustCompile(`^\S`)
	pnpmItemRe           = regexp.MustCompile(`^\s*-\s*['"]?([^'"\s#]+)['"]?`)
)

// DiscoverWorkspacePatterns finds workspace glob patterns for root: first
// pnpm-workspace.yaml (hand-rolled line parser, not a YAML library), then
// the root package.json `workspaces` (array or {packages:[]}), then
// lerna.json `packages`. Patterns are stripped of a leading "./" and
// trailing "/"; default is ["packages/*"]. Verbatim port of
// visDiscoverWorkspacePatterns (draht-tools.cjs:1595-1638).
func DiscoverWorkspacePatterns(root string) ([]string, error) {
	var order []string
	seen := make(map[string]struct{})
	add := func(p string) {
		p = strings.TrimPrefix(p, "./")
		p = strings.TrimSuffix(p, "/")
		if p == "" {
			return
		}
		if _, ok := seen[p]; ok {
			return
		}
		seen[p] = struct{}{}
		order = append(order, p)
	}

	// 1) pnpm-workspace.yaml
	if data, err := os.ReadFile(filepath.Join(root, "pnpm-workspace.yaml")); err == nil {
		inPackages := false
		for _, rawLine := range strings.Split(string(data), "\n") {
			line := strings.TrimSuffix(rawLine, "\r")
			if pnpmPackagesHeaderRe.MatchString(line) {
				inPackages = true
				continue
			}
			if !inPackages {
				continue
			}
			if pnpmNonIndentRe.MatchString(line) && !pnpmDashLineRe.MatchString(line) {
				inPackages = false
				continue
			}
			if m := pnpmItemRe.FindStringSubmatch(line); m != nil {
				add(m[1])
			}
		}
	}

	// 2) root package.json `workspaces`
	if data, err := os.ReadFile(filepath.Join(root, "package.json")); err == nil {
		var pj struct {
			Workspaces json.RawMessage `json:"workspaces"`
		}
		if err := json.Unmarshal(data, &pj); err == nil && len(pj.Workspaces) > 0 {
			var arr []string
			if err := json.Unmarshal(pj.Workspaces, &arr); err == nil {
				for _, p := range arr {
					add(p)
				}
			} else {
				var obj struct {
					Packages []string `json:"packages"`
				}
				if err := json.Unmarshal(pj.Workspaces, &obj); err == nil {
					for _, p := range obj.Packages {
						add(p)
					}
				}
			}
		}
	}

	// 3) lerna.json
	if data, err := os.ReadFile(filepath.Join(root, "lerna.json")); err == nil {
		var lj struct {
			Packages []string `json:"packages"`
		}
		if err := json.Unmarshal(data, &lj); err == nil {
			for _, p := range lj.Packages {
				add(p)
			}
		}
	}

	// 4) sensible default
	if len(order) == 0 {
		order = append(order, "packages/*")
	}
	return order, nil
}

// readDirSorted lists dir, sorted ascending by name. A read error yields an
// empty (not error) result, matching visExpandWorkspacePattern's
// try/catch-and-return.
func readDirSorted(dir string) []os.DirEntry {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	return entries
}

// wildcardSegmentRe builds the regexp for a partial-wildcard glob segment
// (e.g. "foo-*"), escaping every RE2-special byte except '*' (which becomes
// ".*"). Verbatim port of the escape/replace pair at
// draht-tools.cjs:1686 — note '?' is deliberately NOT escaped (it survives
// as a regex quantifier, an intentional-but-odd faithfulness requirement).
func wildcardSegmentRe(segment string) *regexp.Regexp {
	const escapeSet = ".+^${}()|[]\\"
	var b strings.Builder
	b.WriteByte('^')
	for _, r := range segment {
		if r == '*' {
			b.WriteString(".*")
			continue
		}
		if strings.ContainsRune(escapeSet, r) {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	b.WriteByte('$')
	return regexp.MustCompile(b.String())
}

// ExpandWorkspacePattern expands one glob pattern (relative to root) into a
// sorted list of package.json paths. Supports "*", "**", and
// partial-wildcard segments; "?" and "[]" are NOT supported as globs (they
// are escaped/left literal, per wildcardSegmentRe). Ignored / dot
// directories are skipped. Verbatim port of visExpandWorkspacePattern
// (draht-tools.cjs:1643-1705).
func ExpandWorkspacePattern(root, pattern string) ([]string, error) {
	pattern = strings.TrimSuffix(pattern, "/package.json")
	var segments []string
	for _, s := range strings.Split(pattern, "/") {
		if s != "" {
			segments = append(segments, s)
		}
	}

	var out []string
	var visit func(currentPath string, remaining []string)
	visit = func(currentPath string, remaining []string) {
		if len(remaining) == 0 {
			pj := filepath.Join(currentPath, "package.json")
			if fileExists(pj) {
				out = append(out, pj)
			}
			return
		}
		info, err := os.Stat(currentPath)
		if err != nil || !info.IsDir() {
			return
		}
		next := remaining[0]
		rest := remaining[1:]

		switch {
		case next == "*":
			for _, e := range readDirSorted(currentPath) {
				if !e.IsDir() {
					continue
				}
				name := e.Name()
				if isDefaultIgnored(name) || strings.HasPrefix(name, ".") {
					continue
				}
				visit(filepath.Join(currentPath, name), rest)
			}
		case next == "**":
			visit(currentPath, rest) // zero-directory match
			for _, e := range readDirSorted(currentPath) {
				if !e.IsDir() {
					continue
				}
				name := e.Name()
				if isDefaultIgnored(name) || strings.HasPrefix(name, ".") {
					continue
				}
				visit(filepath.Join(currentPath, name), remaining) // keep ** alive
			}
		case strings.Contains(next, "*"):
			re := wildcardSegmentRe(next)
			for _, e := range readDirSorted(currentPath) {
				if !e.IsDir() {
					continue
				}
				name := e.Name()
				if isDefaultIgnored(name) || !re.MatchString(name) {
					continue
				}
				visit(filepath.Join(currentPath, name), rest)
			}
		default:
			visit(filepath.Join(currentPath, next), rest)
		}
	}

	visit(root, segments)
	return out, nil
}

// manifestFields is the subset of package.json decoded per manifest.
type manifestFields struct {
	Name             string          `json:"name"`
	Version          string          `json:"version"`
	Description      string          `json:"description"`
	Dependencies     json.RawMessage `json:"dependencies"`
	DevDependencies  json.RawMessage `json:"devDependencies"`
	PeerDependencies json.RawMessage `json:"peerDependencies"`
	Bin              json.RawMessage `json:"bin"`
	Main             string          `json:"main"`
	Module           string          `json:"module"`
	Exports          json.RawMessage `json:"exports"`
}

// readPackage reads and decodes one manifest into a Package. ok is false on
// any read/parse error, matching visScanPackages' silent per-manifest skip.
func readPackage(root, manifestPath, rootPkgPath string, patterns []string) (Package, bool) {
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return Package{}, false
	}
	var pj manifestFields
	if err := json.Unmarshal(raw, &pj); err != nil {
		return Package{}, false
	}

	dir := filepath.Dir(manifestPath)
	name := pj.Name
	if name == "" {
		name = filepath.Base(dir)
	}

	relPath, err := filepath.Rel(root, dir)
	if err != nil || relPath == "" || relPath == "." {
		relPath = "."
	} else {
		relPath = filepath.ToSlash(relPath)
	}

	deps, depValues := decodeDeps(pj.Dependencies)
	devDeps, _ := decodeDeps(pj.DevDependencies)
	peerDeps, _ := decodeDeps(pj.PeerDependencies)

	var workspaceDeps []string
	for _, depName := range deps {
		if strings.HasPrefix(depValues[depName], "workspace:") {
			workspaceDeps = append(workspaceDeps, depName)
		}
	}

	exportLeaves, _ := exportLeavesFromRaw(pj.Exports)

	pkg := Package{
		Name:             name,
		Path:             relPath,
		Dependencies:     deps,
		DevDependencies:  devDeps,
		PeerDependencies: peerDeps,
		WorkspaceDeps:    workspaceDeps,
		Bin:              parseBin(pj.Bin, name),
		Main:             pj.Main,
		Module:           pj.Module,
		ExportLeaves:     exportLeaves,
	}
	if pj.Version != "" {
		v := pj.Version
		pkg.Version = &v
	}
	if pj.Description != "" {
		d := pj.Description
		pkg.Description = &d
	}
	if manifestPath == rootPkgPath {
		pkg.WorkspacePatterns = patterns
	}
	return pkg, true
}

// ScanPackages reads the root manifest plus every workspace pattern's
// manifest, in insertion order, deduplicated by absolute path. Patterns
// starting with "!" are skipped; unparseable manifests are skipped
// silently. Verbatim port of visScanPackages (draht-tools.cjs:1707-1743).
func ScanPackages(root string) ([]Package, error) {
	rootPkgPath := filepath.Join(root, "package.json")
	rootExists := fileExists(rootPkgPath)

	seen := make(map[string]struct{})
	var candidates []string
	if rootExists {
		seen[rootPkgPath] = struct{}{}
		candidates = append(candidates, rootPkgPath)
	}

	patterns, err := DiscoverWorkspacePatterns(root)
	if err != nil {
		return nil, fmt.Errorf("scan: discover workspace patterns: %w", err)
	}

	for _, pat := range patterns {
		if strings.HasPrefix(pat, "!") {
			continue // negated patterns unsupported, matching the CJS "for simplicity"
		}
		found, err := ExpandWorkspacePattern(root, pat)
		if err != nil {
			continue
		}
		for _, f := range found {
			if _, ok := seen[f]; !ok {
				seen[f] = struct{}{}
				candidates = append(candidates, f)
			}
		}
	}

	pkgs := make([]Package, 0, len(candidates))
	for _, p := range candidates {
		if pkg, ok := readPackage(root, p, rootPkgPath, patterns); ok {
			pkgs = append(pkgs, pkg)
		}
	}
	return pkgs, nil
}

// PackageForRel attributes rel to a package: first-match-wins over pkgs
// order, NOT longest-prefix (see the nested-workspace-package fixture in
// design §6 pkgjson_test.go). Falls back to pkgs[0] when it is the root
// manifest (Path == "."). Verbatim port of the module->package attribution
// rule at draht-tools.cjs:2170-2171.
func PackageForRel(pkgs []Package, rel string) (Package, bool) {
	for _, p := range pkgs {
		if p.Path != "." && strings.HasPrefix(rel, p.Path+"/") {
			return p, true
		}
	}
	if len(pkgs) > 0 && pkgs[0].Path == "." {
		return pkgs[0], true
	}
	return Package{}, false
}
