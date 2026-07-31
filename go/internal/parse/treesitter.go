package parse

import (
	"context"
	"fmt"
	"runtime/debug"
	"sort"
	"strings"

	gts "github.com/odvcencio/gotreesitter"
	"github.com/odvcencio/gotreesitter/grammars"

	"github.com/draht-dev/draht/go/internal/langset"
)

// gotreesitterModulePath is the dependency whose version is folded into
// Version() so a `go get -u` invalidates the extraction cache without
// requiring a manual queryRev bump.
const gotreesitterModulePath = "github.com/odvcencio/gotreesitter"

// gotreesitterVersion resolves the actually-linked gotreesitter module
// version via debug.ReadBuildInfo, falling back to "unknown" only when
// build info is unavailable. NOTE: `go test`-compiled binaries do NOT embed
// a dependency list (verified: `go version -m` on a `go test -c` binary
// shows zero `dep` lines, vs. a normal `go build` binary of the same
// package, which does) — so this always returns "unknown" when called from
// inside `go test`. That is a Go toolchain limitation, not a bug here; the
// real production `draht-tools` binary (built via `go build`/`make build`)
// resolves the true pinned version. See LibraryVersion's doc and
// cmd/draht-tools/main_test.go for the end-to-end verification that catches
// drift against go.mod.
func gotreesitterVersion() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "unknown"
	}
	for _, dep := range info.Deps {
		if dep.Path == gotreesitterModulePath {
			if dep.Replace != nil {
				return dep.Replace.Version
			}
			return dep.Version
		}
	}
	return "unknown"
}

// LibraryVersion exports gotreesitterVersion for callers outside this
// package (the CLI's `--version` output) that want to display/verify the
// actually-linked gotreesitter dependency version.
func LibraryVersion() string { return gotreesitterVersion() }

type tsOpts struct {
	maxBytes     int
	maxLineBytes int
	matchLimit   uint32
}

// TSOption configures NewTreeSitter.
type TSOption func(*tsOpts)

// WithMaxBytes skips AST parsing above n bytes (0 = no limit).
func WithMaxBytes(n int) TSOption { return func(o *tsOpts) { o.maxBytes = n } }

// WithMaxLineBytes skips AST parsing when the longest line exceeds n bytes
// (0 = no limit).
func WithMaxLineBytes(n int) TSOption { return func(o *tsOpts) { o.maxLineBytes = n } }

// WithMatchLimit sets QueryCursor.SetMatchLimit (0 = library default, 1e6).
func WithMatchLimit(n uint32) TSOption { return func(o *tsOpts) { o.matchLimit = n } }

// LangKit is one grammar's eagerly-built pool + compiled query. Pool.Parse
// and Query.Exec (with a fresh QueryCursor per call) are both documented
// concurrency-safe by gotreesitter, so a LangKit may be shared by every
// worker goroutine without additional locking.
type LangKit struct {
	Name  string
	Lang  *gts.Language
	Pool  *gts.ParserPool
	Query *gts.Query // nil when ImportQueryFor has no query for this grammar
}

type treeSitterParser struct {
	langs      []Lang
	opts       tsOpts
	kits       map[string]*LangKit // keyed by gotreesitter grammar name
	libVersion string              // resolved once at construction; see gotreesitterVersion
}

// NewTreeSitter builds the grammar pools + compiled queries eagerly for the
// languages in langs (grammar blob deserialization costs 2-106 ms each; doing
// it lazily inside workers would serialize construction behind a mutex).
// "typescript" implicitly also builds the "tsx" grammar, since parse.Lang has
// no distinct tsx value (scan classifies both .ts and .tsx as "typescript";
// grammarFor picks the grammar from the file extension at Extract time).
// Unknown/unsupported langs, and grammars gotreesitter cannot resolve or
// load, are silently skipped — Supports reports the resulting truth. Never
// returns nil.
func NewTreeSitter(langs []Lang, opts ...TSOption) (Parser, error) {
	var o tsOpts
	for _, opt := range opts {
		opt(&o)
	}

	p := &treeSitterParser{
		langs:      append([]Lang(nil), langs...),
		opts:       o,
		kits:       map[string]*LangKit{},
		libVersion: gotreesitterVersion(),
	}

	// langset.GrammarNamesFor is also what generates the shipped binary's
	// grammar_subset build tags (cmd/grammar-tags) — routing both through
	// the same function is what keeps "languages this parser tries to
	// load" and "grammars actually compiled into the binary" from silently
	// disagreeing. Its output is already sorted, giving deterministic
	// construction order (which has no observable effect on Extract's
	// output, but makes any future build-time diagnostics reproducible).
	langStrs := make([]string, len(langs))
	for i, l := range langs {
		langStrs[i] = string(l)
	}
	names := langset.GrammarNamesFor(langStrs)

	for _, g := range names {
		entry := grammars.DetectLanguageByName(g)
		if entry == nil {
			continue
		}
		lang := entry.Language()
		if lang == nil {
			continue
		}
		kit := &LangKit{Name: entry.Name, Lang: lang, Pool: gts.NewParserPool(lang)}
		if qsrc := ImportQueryFor(entry.Name); qsrc != "" {
			q, err := gts.NewQuery(qsrc, lang)
			if err != nil {
				return nil, fmt.Errorf("parse: compiling import query for grammar %q: %w", g, err)
			}
			kit.Query = q
		}
		p.kits[g] = kit
	}

	return p, nil
}

func (p *treeSitterParser) Supports(lang Lang) bool {
	g := grammarFor(lang, "")
	if g == "" {
		return false
	}
	kit, ok := p.kits[g]
	return ok && kit.Query != nil
}

// Extract implements Parser.Extract. It never panics: any internal panic
// (from gotreesitter or from this function's own node-walking logic) is
// recovered and returned as an error, per the Parser contract, so one
// pathological file cannot kill the whole indexing run.
func (p *treeSitterParser) Extract(ctx context.Context, lang Lang, path string, src []byte) (result Result, err error) {
	if err = ctx.Err(); err != nil {
		return Result{}, err
	}

	grammar := grammarFor(lang, path)
	if grammar == "" {
		return Result{}, fmt.Errorf("parse: unsupported language %q", lang)
	}
	kit, ok := p.kits[grammar]
	if !ok || kit.Query == nil {
		return Result{}, fmt.Errorf("parse: no import query for grammar %q (lang %q)", grammar, lang)
	}

	if p.opts.maxBytes > 0 && len(src) > p.opts.maxBytes {
		return Result{}, nil
	}
	if p.opts.maxLineBytes > 0 && longestLine(src) > p.opts.maxLineBytes {
		return Result{}, nil
	}

	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("parse: panic extracting imports (grammar %q, path %q): %v", grammar, path, r)
			result = Result{}
		}
	}()

	tree, perr := kit.Pool.Parse(src)
	if perr != nil {
		return Result{}, fmt.Errorf("parse: %s: %w", grammar, perr)
	}
	if tree == nil {
		return Result{}, fmt.Errorf("parse: %s: parser returned a nil tree", grammar)
	}
	defer tree.Release() // MANDATORY: 13x allocation difference measured without it (spike Q5).

	degraded := tree.RootNode().HasError()

	cursor := kit.Query.Exec(tree.RootNode(), kit.Lang, src)
	if p.opts.matchLimit > 0 {
		cursor.SetMatchLimit(p.opts.matchLimit)
	}

	imports := groupImports(cursor, kit.Lang, grammar, src)
	if cursor.DidExceedMatchLimit() {
		degraded = true
	}

	return Result{Imports: imports, Degraded: degraded}, nil
}

// Version identifies the query revision, the gotreesitter dependency
// version actually linked into this binary, AND the AST size-limit options
// (maxBytes/maxLineBytes) that change Extract's observable behaviour (a
// file that's skipped for exceeding a limit produces a materially
// different Result than one that's fully parsed). Every one of these MUST
// be part of the cache key: a run with different opts.maxBytes/maxLineBytes
// must never reuse another run's cached facts (see cache.ComposeVersion's
// caller in graph/pipeline.go). libVersion is resolved once at construction
// time via gotreesitterVersion() (debug.ReadBuildInfo), not hardcoded, so a
// `go get -u` of the dependency also invalidates the cache automatically.
func (p *treeSitterParser) Version() string {
	return fmt.Sprintf("ts/%d+gotreesitter@%s+b%d+l%d", queryRev, p.libVersion, p.opts.maxBytes, p.opts.maxLineBytes)
}

func (p *treeSitterParser) Close() error { return nil }

// longestLine returns the length, in bytes, of the longest line in src
// (delimited by '\n'; a trailing '\r' is not stripped, matching the CJS
// engine's newline-only line splitting elsewhere in the design).
func longestLine(src []byte) int {
	longest, cur := 0, 0
	for _, b := range src {
		if b == '\n' {
			if cur > longest {
				longest = cur
			}
			cur = 0
			continue
		}
		cur++
	}
	if cur > longest {
		longest = cur
	}
	return longest
}

// group accumulates every capture belonging to one @stmt anchor node before
// it is turned into a single Import record at finalize time.
type group struct {
	offset uint32
	row    uint32
	kind   Kind

	module    string // primary specifier (source/module/dynamic/require/path/crate/mod)
	moduleAlt string // fallback specifier, used only by csharp's module_alt bucket

	def string // Import.Default
	ns  string // Import.Namespace

	sawWildcard bool // java "*"/kotlin wildcard_import -> Namespace "*" fallback
	sawDynamic  bool // ts/js dynamic import() -> KindDynamic override
	sawRequire  bool // ts/js require() -> KindRequire override

	pendingAlias string // an alias not already paired with a symbol in-match; reconciled at finalize

	names     []Name
	seenNames map[string]bool
}

// groupImports drains every match from cursor, grouping captures by their
// @stmt anchor's byte offset, then emits one Import per group in ascending
// offset order (source order) — the ordering treesitter.Result guarantees per
// the Parser contract.
func groupImports(cursor *gts.QueryCursor, lang *gts.Language, grammar string, src []byte) []Import {
	groups := map[uint32]*group{}
	var order []uint32

	for {
		m, ok := cursor.NextMatch()
		if !ok {
			break
		}

		var stmt *gts.Node
		for i := range m.Captures {
			if m.Captures[i].Name == "stmt" {
				stmt = m.Captures[i].Node
			}
		}
		if stmt == nil {
			continue
		}

		key := stmt.StartByte()
		g := groups[key]
		if g == nil {
			g = &group{
				offset:    key,
				row:       stmt.StartPoint().Row,
				kind:      kindForNodeType(grammar, stmt.Type(lang)),
				seenNames: map[string]bool{},
			}
			groups[key] = g
			order = append(order, key)
		}

		// A "symbol" AND an "alias" captured together in the SAME match is a
		// per-symbol rename (rust `Serialize as Ser` inside a use-list;
		// python `from M import X as Y`): combine directly into one Name,
		// entirely independent of any other match's captures for this
		// group, so the result never depends on NextMatch's match order.
		var symbolText, aliasText string
		var haveSymbol, haveAlias bool
		for i := range m.Captures {
			switch m.Captures[i].Name {
			case "symbol":
				symbolText, haveSymbol = captureText(m.Captures[i], src), true
			case "alias":
				aliasText, haveAlias = captureText(m.Captures[i], src), true
			}
		}
		pairedAlias := haveSymbol && haveAlias

		for i := range m.Captures {
			c := m.Captures[i]
			name := c.Name
			if name == "" || name == "stmt" || strings.HasPrefix(name, "_") {
				continue // "_fn"/"_m"/"_cmd" style captures exist only for #eq? predicates
			}
			txt := captureText(c, src)

			switch name {
			case "source", "module", "path", "crate", "mod":
				g.module = txt
			case "module_alt":
				g.moduleAlt = txt
			case "module_angle":
				g.module = strings.Trim(txt, "<>")
			case "dynamic":
				g.module = txt
				g.sawDynamic = true
			case "require":
				g.module = txt
				g.sawRequire = true
			case "default":
				g.def = txt
			case "namespace":
				g.ns = txt
			case "wildcard":
				g.sawWildcard = true
			case "wildcard_bare":
				// ts/js bare `export * from "m"`: marker-only capture, same
				// text as the "source" capture from the sibling pattern —
				// only its presence matters.
				g.sawWildcard = true
			case "symbol_wildcard":
				// python `from X import *`: marker-only, Namespace "*"
				// fallback at finalize, not a Names entry.
				g.sawWildcard = true
			case "path_wildcard":
				// rust `use foo::*;`: use_wildcard's text is the WHOLE
				// "foo::*", not just "*" — strip the trailing wildcard
				// marker to recover the module path.
				g.module = stripWildcardSuffix(txt)
				g.sawWildcard = true
			case "spec":
				addSpecName(g, txt)
			case "symbol":
				if pairedAlias {
					addName(g, Name{Imported: symbolText, Local: aliasText})
				} else {
					addName(g, Name{Imported: txt})
				}
			case "alias":
				if !pairedAlias {
					g.pendingAlias = aliasText
				}
				// when pairedAlias, the "symbol" branch above already
				// consumed both captures together.
			}
		}
	}

	sort.Slice(order, func(i, j int) bool { return order[i] < order[j] })

	out := make([]Import, 0, len(order))
	for _, key := range order {
		g := groups[key]

		module := g.module
		if module == "" {
			module = g.moduleAlt
		}
		if module == "" {
			// e.g. a local `export { x }` with no source: not a graph edge.
			continue
		}

		kind := g.kind
		switch {
		case g.sawDynamic:
			kind = KindDynamic
		case g.sawRequire:
			kind = KindRequire
		}

		ns := g.ns
		if ns == "" && g.sawWildcard {
			ns = "*"
		}

		def := g.def
		names := g.names
		if g.pendingAlias != "" {
			if grammar == "go" {
				// Go's import alias IS the package's local identifier
				// (including "_" and "."), not a symbol rename.
				def = g.pendingAlias
			} else {
				names = append(append([]Name(nil), names...), Name{
					Imported: lastPathSegment(module),
					Local:    g.pendingAlias,
				})
			}
		}

		out = append(out, Import{
			Kind:      kind,
			Specifier: module,
			Default:   def,
			Namespace: ns,
			Names:     names,
			Line:      int(g.row) + 1,
			Offset:    int(g.offset),
		})
	}
	return out
}

func captureText(c gts.QueryCapture, src []byte) string {
	if c.TextOverride != "" {
		return strings.TrimSpace(c.TextOverride)
	}
	return strings.TrimSpace(c.Node.Text(src))
}

func addName(g *group, n Name) {
	if n.Local == n.Imported {
		n.Local = ""
	}
	key := n.Imported + "\x00" + n.Local
	if g.seenNames[key] {
		return
	}
	g.seenNames[key] = true
	g.names = append(g.names, n)
}

// addSpecName parses a ts/js named-import-or-export specifier's text, which
// is either "name" or "name as local".
func addSpecName(g *group, txt string) {
	imported, local := txt, ""
	if idx := strings.Index(txt, " as "); idx >= 0 {
		imported = strings.TrimSpace(txt[:idx])
		local = strings.TrimSpace(txt[idx+len(" as "):])
	}
	addName(g, Name{Imported: imported, Local: local})
}

// lastPathSegment returns the final '.', '/', '\\' or "::"-delimited segment
// of spec, used to derive a plausible Imported name for languages whose
// module-level alias renames the last path component (kotlin `as`, rust
// `use a::b as c`, csharp `using X = a.b;`, python `import a.b as c`).
func lastPathSegment(spec string) string {
	spec = strings.TrimRight(spec, ".*")
	for i := len(spec) - 1; i >= 0; i-- {
		switch spec[i] {
		case '.', '/', '\\', ':':
			return spec[i+1:]
		}
	}
	return spec
}

// stripWildcardSuffix strips a trailing rust wildcard-use marker ("::*",
// ".*", or a bare "*") from a use_wildcard node's full text, recovering the
// module path the wildcard was applied to (may be "").
func stripWildcardSuffix(s string) string {
	switch {
	case strings.HasSuffix(s, "::*"):
		return s[:len(s)-len("::*")]
	case strings.HasSuffix(s, ".*"):
		return s[:len(s)-len(".*")]
	case strings.HasSuffix(s, "*"):
		return s[:len(s)-len("*")]
	default:
		return s
	}
}

// kindForNodeType classifies a @stmt node's grammar node type into the four
// Kind values parse.Import supports. It is overridden after the fact for
// ts/js call_expression nodes (KindDynamic/KindRequire), which share a node
// type with every other function call and so cannot be classified by type
// alone.
func kindForNodeType(grammar, nodeType string) Kind {
	switch grammar {
	case "typescript", "tsx", "javascript":
		switch nodeType {
		case "export_statement":
			return KindReExport
		default:
			return KindImport
		}
	case "ruby":
		return KindRequire // require / require_relative
	case "php":
		switch nodeType {
		case "namespace_use_declaration":
			return KindImport
		default:
			return KindRequire // require(_once) / include(_once)
		}
	case "bash":
		return KindRequire // `source` / `.` loads and executes another file
	default:
		return KindImport
	}
}
