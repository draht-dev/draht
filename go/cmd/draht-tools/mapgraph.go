package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/draht-dev/draht/go/internal/emit"
	"github.com/draht-dev/draht/go/internal/graph"
	"github.com/draht-dev/draht/go/internal/langset"
	"github.com/draht-dev/draht/go/internal/parse"
	"github.com/draht-dev/draht/go/internal/scan"
)

// mapGraphUsage is printed for `map-graph -h`/`--help`.
const mapGraphUsage = `Usage: draht-tools map-graph [dir] [flags]

flags:
  -q, --quiet                 single-line output; MAP.json only (hook path)
      --jobs N                worker count (default: min(GOMAXPROCS, 8))
      --parser NAME            treesitter | regex          (default: treesitter)
      --no-cache               bypass the extraction cache entirely
      --cache-dir PATH         override <repoRoot>/.planning/codebase/.cache/graph-v1
                               (env GRAPH_CACHE_DIR; flag wins)
      --out DIR                output directory (default: <repoRoot>/.planning/codebase)
      --ast-max-bytes N        skip AST parse above N bytes (default 0 = no limit)
      --ast-max-line N         skip AST parse if longest line > N bytes (default 0 = no limit)
      --verbose                per-file warnings + cache diagnostics on stderr
      --experimental-lang-edges
                               PHASE 1 STUB: exits 2
  -h, --help                   show this help
`

// mapGraphOptions is the parsed flag set for `map-graph`.
type mapGraphOptions struct {
	dir                   string
	quiet                 bool
	jobs                  int
	parserName            string
	noCache               bool
	cacheDir              string
	out                   string
	astMaxBytes           int
	astMaxLine            int
	verbose               bool
	experimentalLangEdges bool
	help                  bool
}

// parseMapGraphArgs parses `map-graph`'s argv, matching the CJS engine's
// permissive style (unhandled positional args are ignored) while adding the
// Go-only flags from design §7. Flags that take a value accept both
// "--flag value" and "--flag=value".
func parseMapGraphArgs(args []string) (mapGraphOptions, error) {
	opts := mapGraphOptions{parserName: "treesitter"}

	next := func(i *int) (string, error) {
		*i++
		if *i >= len(args) {
			return "", fmt.Errorf("flag %s requires a value", args[*i-1])
		}
		return args[*i], nil
	}

	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--quiet" || a == "-q":
			opts.quiet = true
		case a == "--no-cache":
			opts.noCache = true
		case a == "--verbose":
			opts.verbose = true
		case a == "--experimental-lang-edges":
			opts.experimentalLangEdges = true
		case a == "-h" || a == "--help":
			opts.help = true
		case a == "--jobs":
			v, err := next(&i)
			if err != nil {
				return opts, err
			}
			n, err := strconv.Atoi(v)
			if err != nil {
				return opts, fmt.Errorf("--jobs: invalid integer %q", v)
			}
			opts.jobs = n
		case strings.HasPrefix(a, "--jobs="):
			n, err := strconv.Atoi(strings.TrimPrefix(a, "--jobs="))
			if err != nil {
				return opts, fmt.Errorf("--jobs: invalid integer")
			}
			opts.jobs = n
		case a == "--parser":
			v, err := next(&i)
			if err != nil {
				return opts, err
			}
			opts.parserName = v
		case strings.HasPrefix(a, "--parser="):
			opts.parserName = strings.TrimPrefix(a, "--parser=")
		case a == "--cache-dir":
			v, err := next(&i)
			if err != nil {
				return opts, err
			}
			opts.cacheDir = v
		case strings.HasPrefix(a, "--cache-dir="):
			opts.cacheDir = strings.TrimPrefix(a, "--cache-dir=")
		case a == "--out":
			v, err := next(&i)
			if err != nil {
				return opts, err
			}
			opts.out = v
		case strings.HasPrefix(a, "--out="):
			opts.out = strings.TrimPrefix(a, "--out=")
		case a == "--ast-max-bytes":
			v, err := next(&i)
			if err != nil {
				return opts, err
			}
			n, err := strconv.Atoi(v)
			if err != nil {
				return opts, fmt.Errorf("--ast-max-bytes: invalid integer %q", v)
			}
			opts.astMaxBytes = n
		case strings.HasPrefix(a, "--ast-max-bytes="):
			n, err := strconv.Atoi(strings.TrimPrefix(a, "--ast-max-bytes="))
			if err != nil {
				return opts, fmt.Errorf("--ast-max-bytes: invalid integer")
			}
			opts.astMaxBytes = n
		case a == "--ast-max-line":
			v, err := next(&i)
			if err != nil {
				return opts, err
			}
			n, err := strconv.Atoi(v)
			if err != nil {
				return opts, fmt.Errorf("--ast-max-line: invalid integer %q", v)
			}
			opts.astMaxLine = n
		case strings.HasPrefix(a, "--ast-max-line="):
			n, err := strconv.Atoi(strings.TrimPrefix(a, "--ast-max-line="))
			if err != nil {
				return opts, fmt.Errorf("--ast-max-line: invalid integer")
			}
			opts.astMaxLine = n
		case strings.HasPrefix(a, "-"):
			return opts, fmt.Errorf("unknown flag: %s", a)
		default:
			if opts.dir == "" {
				opts.dir = a
			}
		}
	}

	return opts, nil
}

// buildParser constructs the parse.Parser named by name (design §7:
// --parser treesitter|regex). astMaxBytes/astMaxLine (0 = no limit) are only
// meaningful for the tree-sitter implementation.
func buildParser(name string, astMaxBytes, astMaxLine int) (parse.Parser, error) {
	switch name {
	case "", "treesitter":
		// design D2: AST import extraction covers exactly these 6 grammars
		// (typescript implicitly also builds "tsx" — see NewTreeSitter).
		// langset.CLILanguages is the single source of truth for this list —
		// it is also what generates the shipped binary's grammar_subset
		// build tags (cmd/grammar-tags). Never hand-write this slice
		// separately; see internal/langset's package doc for why.
		langs := make([]parse.Lang, len(langset.CLILanguages))
		for i, l := range langset.CLILanguages {
			langs[i] = parse.Lang(l)
		}
		var tsOpts []parse.TSOption
		if astMaxBytes > 0 {
			tsOpts = append(tsOpts, parse.WithMaxBytes(astMaxBytes))
		}
		if astMaxLine > 0 {
			tsOpts = append(tsOpts, parse.WithMaxLineBytes(astMaxLine))
		}
		return parse.NewTreeSitter(langs, tsOpts...)
	case "regex":
		return parse.NewRegex(), nil
	default:
		return nil, fmt.Errorf("unknown --parser %q (want treesitter or regex)", name)
	}
}

// runMapGraph implements `draht-tools map-graph [dir] [flags]` and returns
// the process exit code. Behaviour ported from design §7 / draht-tools.cjs
// 5130-5152: the graph ALWAYS maps the whole repo regardless of a `dir` arg
// or cwd (WP6, defect 22); a mismatched `dir` prints an informational note
// but never changes what gets mapped.
func runMapGraph(args []string) int {
	opts, err := parseMapGraphArgs(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, "map-graph:", err)
		return 1
	}
	if opts.help {
		fmt.Print(mapGraphUsage)
		return 0
	}
	if opts.experimentalLangEdges {
		fmt.Fprintln(os.Stderr, "experimental language edges are not implemented in phase 1")
		return 2
	}

	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, "map-graph:", err)
		return 1
	}
	repoRoot, err := scan.FindRepoRoot(cwd)
	if err != nil {
		fmt.Fprintln(os.Stderr, "map-graph:", err)
		return 1
	}

	if opts.dir != "" {
		if abs, aerr := filepath.Abs(opts.dir); aerr == nil && abs != repoRoot {
			fmt.Printf("note: map-graph always maps the whole repo (%s); '%s' ignored for the graph\n", repoRoot, opts.dir)
		}
	}

	cacheDir := os.Getenv("GRAPH_CACHE_DIR")
	if opts.cacheDir != "" {
		cacheDir = opts.cacheDir
	}

	parser, err := buildParser(opts.parserName, opts.astMaxBytes, opts.astMaxLine)
	if err != nil {
		fmt.Fprintln(os.Stderr, "map-graph:", err)
		return 1
	}
	defer parser.Close()

	buildOpts := graph.Options{
		Root:        repoRoot,
		OutDir:      opts.out,
		CacheDir:    cacheDir,
		Jobs:        opts.jobs,
		Parser:      parser,
		NoCache:     opts.noCache,
		ASTMaxBytes: opts.astMaxBytes,
		ASTMaxLine:  opts.astMaxLine,
		Quiet:       opts.quiet,
	}

	m, report, err := graph.Build(context.Background(), buildOpts)
	if err != nil {
		fmt.Fprintln(os.Stderr, "map-graph:", err)
		return 1
	}

	outDir := opts.out
	if outDir == "" {
		outDir = scan.GraphOutDir(repoRoot)
	}
	jsonPath := filepath.Join(outDir, "MAP.json")

	if opts.verbose {
		for _, w := range report.Warnings {
			fmt.Fprintln(os.Stderr, "warn:", w)
		}
		fmt.Fprintf(os.Stderr, "cache: %d hit / %d miss\n", report.CacheHits, report.CacheMisses)
	}

	// visWriteOutputs (cjs:5098-5124): GRAPH_REPORT.md shares MAP.json's
	// unchanged-gate (report.Changed, from graph.Build's own
	// model.WriteIfChanged call); MAP.html is unconditional unless --quiet.
	// This runs on BOTH the quiet and non-quiet paths — the CJS's --quiet
	// flag only skips the HTML write, never the report.
	res, emitErr := emit.WriteOutputs(outDir, m, report.Changed, opts.quiet)
	if emitErr != nil {
		fmt.Fprintln(os.Stderr, "map-graph:", emitErr)
		return 1
	}

	if opts.quiet {
		fmt.Printf("map-graph: %d modules · schemaVersion %d · %dms → %s\n",
			report.Modules, m.SchemaVersion, report.BuildMs, jsonPath)
		return 0
	}

	fmt.Println(strings.Repeat("━", 55))
	fmt.Println(" DRAHT ► MAP-GRAPH")
	fmt.Println(strings.Repeat("━", 55))

	fmt.Printf("\nWrote:\n  %s\n  %s\n  %s\n", res.JSONPath, res.HTMLPath, res.ReportPath)

	fmt.Printf("\nIndexed %d modules · %s LOC · %d edges · %d clusters in %dms\n",
		report.Modules, commaInt(report.TotalLoc), report.Edges, len(m.Clusters), report.BuildMs)

	fmt.Printf("\nRead the report: %s   ·   Serve live: draht-tools map-serve\n", res.ReportPath)

	return 0
}

// commaInt formats n with "," thousands separators (a hand-rolled grouper —
// never a locale-dependent formatter like JS's toLocaleString(), which the
// CJS engine uses and which the design explicitly calls out as a golden-test
// hazard we are not inheriting).
func commaInt(n int) string {
	neg := n < 0
	if neg {
		n = -n
	}
	s := strconv.Itoa(n)
	var b strings.Builder
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	out := b.String()
	if neg {
		out = "-" + out
	}
	return out
}
