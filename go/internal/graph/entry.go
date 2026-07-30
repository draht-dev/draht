package graph

import (
	"path"
	"strings"

	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/scan"
)

// mainKeyPrefix marks a binFiles entry that records a package's `main`
// field rather than a `bin` entry (draht-tools.cjs:2117 "__main__:" prefix).
const mainKeyPrefix = "__main__:"

// compiledSegments are the path segments BuildBinFiles rewrites to "src"
// when registering a source-tree fallback (draht-tools.cjs:2083
// COMPILED_SEGMENT_RE = /(?:^|\/)(?:dist|build|lib|out)\//).
var compiledSegments = map[string]struct{}{
	"dist": {}, "build": {}, "lib": {}, "out": {},
}

// sourceExts are the extensions BuildBinFiles probes when registering a
// compiled-output -> source-tree fallback (draht-tools.cjs:2084
// SOURCE_EXTS).
var sourceExts = []string{".ts", ".tsx", ".js", ".mjs", ".cjs"}

// srcFallback rewrites the FIRST path segment equal to dist/build/lib/out
// to "src" and strips a trailing .js/.mjs/.cjs extension, mirroring
// draht-tools.cjs:2088-2097's callback-based regex substitution without
// requiring RE2 lookbehind support (design Risk R2). ok is false when rel
// contains no compiled-output segment.
func srcFallback(rel string) (stem string, ok bool) {
	segs := strings.Split(rel, "/")
	for i, s := range segs {
		if _, isCompiled := compiledSegments[s]; !isCompiled {
			continue
		}
		out := make([]string, len(segs))
		copy(out, segs)
		out[i] = "src"
		stem = strings.Join(out, "/")
		for _, ext := range []string{".js", ".mjs", ".cjs"} {
			if strings.HasSuffix(stem, ext) {
				stem = strings.TrimSuffix(stem, ext)
				break
			}
		}
		return stem, true
	}
	return "", false
}

// posixJoinTrim ports `path.posix.join(dir, file).replace(/^\.\//, "")`.
func posixJoinTrim(dir, file string) string {
	return strings.TrimPrefix(path.Join(dir, file), "./")
}

// BuildBinFiles constructs the binFiles map (draht-tools.cjs:2078-2120):
// for every package's `bin` entries (string or object form) and `main`
// field, it registers the literal declared path against the bin/main
// "name", plus — when the declared path crosses a compiled-output segment
// (dist|build|lib|out) — every SOURCE_EXTS variant of the src-rewritten
// stem, so a `dist/cli.js` main still recognizes `src/cli.ts` in the
// scanned tree as the entry point.
//
// `main` entries are stored under the mainKeyPrefix ("__main__:") with
// name "main:"+pkg.Name; callers strip that prefix when reading it back
// (see assignEntryPoint).
func BuildBinFiles(pkgs []scan.Package) map[string]string {
	binFiles := make(map[string]string)

	register := func(rel, name, prefix string) {
		fullKey := prefix + rel
		binFiles[fullKey] = name // cjs: Map.set always overwrites.
		if stem, ok := srcFallback(rel); ok {
			for _, ext := range sourceExts {
				key := prefix + stem + ext
				if _, exists := binFiles[key]; !exists {
					binFiles[key] = name
				}
			}
		}
	}

	for _, p := range pkgs {
		pkgDir := p.Path
		if pkgDir == "." {
			pkgDir = ""
		}
		for _, b := range p.Bin {
			rel := posixJoinTrim(pkgDir, b.File)
			register(rel, b.Name, "")
		}
		if p.Main != "" {
			rel := posixJoinTrim(pkgDir, p.Main)
			register(rel, "main:"+p.Name, mainKeyPrefix)
		}
	}
	return binFiles
}

// assignEntryPoint computes a module's *model.ModuleEntryPoint
// (draht-tools.cjs:2189-2198). Precedence: cli (binName present) beats http
// (routes present and not a test file) beats library (this file is some
// package's declared `main`, and no higher-precedence entry point was
// already assigned).
//
// binName is binFiles[rel] ("" if this file is not a bin entry). mainName
// is binFiles["__main__:"+rel] with the "main:" prefix already stripped
// ("" if this file is not any package's main).
func assignEntryPoint(binName, mainName string, routes []model.Route, isTest bool) *model.ModuleEntryPoint {
	var ep *model.ModuleEntryPoint
	switch {
	case binName != "":
		ep = &model.ModuleEntryPoint{Kind: model.EntryKindCLI, Name: binName}
	case len(routes) > 0 && !isTest:
		capped := routes
		if len(capped) > 8 {
			capped = capped[:8]
		}
		ep = &model.ModuleEntryPoint{Kind: model.EntryKindHTTP, Routes: capped}
	}
	if ep == nil && mainName != "" {
		ep = &model.ModuleEntryPoint{Kind: model.EntryKindLibrary, Name: mainName}
	}
	return ep
}

// mainNameFor reads binFiles["__main__:"+rel] and strips the "main:"
// prefix cjs stores it with, returning "" when rel is not any package's
// declared main.
func mainNameFor(binFiles map[string]string, rel string) string {
	raw, ok := binFiles[mainKeyPrefix+rel]
	if !ok {
		return ""
	}
	return strings.TrimPrefix(raw, "main:")
}
