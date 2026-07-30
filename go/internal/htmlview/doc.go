// Package htmlview ships draht-tools.cjs's MAP.html viewer (visRenderHtml,
// draht-tools.cjs lines 3015-5044) as a Go-embedded asset and performs the
// only two substitutions the CJS template performs: injecting the map's JSON
// and the on-disk JSON file's relative path.
//
// # Why the asset is not hand-written
//
// The viewer is ~2,000 lines of CSS/HTML/vanilla JS (layout, inspector,
// SVG export, live-reload client). None of that is reimplemented in Go: the
// static portion of the template literal is extracted VERBATIM from the CJS
// source and embedded as asset/viewer.html.tmpl via go:embed. Only the two
// dynamic interpolations the CJS performs are reproduced here:
//
//	<script id="map-data" type="application/json">${embeddedJson}</script>
//	var JSON_PATH = ${JSON.stringify("./" + jsonName)};
//
// # Re-lifting the asset
//
// If visRenderHtml's static template ever changes upstream (while the CJS
// engine still exists), regenerate the asset with:
//
//	node go/internal/htmlview/asset/extract.mjs \
//	    packages/draht-tools/bin/draht-tools.cjs \
//	    go/internal/htmlview/asset
//
// This evaluates the template literal (via `(0, eval)`) rather than copying
// source lines, because the source carries JS escape sequences (\s, \n,
// \x60, ...) inside string/regex literals that only collapse correctly when
// the literal is actually interpreted as JS — a sed/awk copy of the source
// text produces a viewer whose regexes and joins are subtly wrong (see cjs
// lines 3319, 3803, 4603, 4764, 4766, 4976). The extractor asserts the
// template contains exactly the two known interpolations before replacing
// them with the tokenMapJSON / tokenJSONPath sentinels, and asserts both
// tokens occur exactly once in the result.
//
// After the CJS engine is eventually deleted, asset/viewer.html.tmpl becomes
// hand-maintained; asset/extract.mjs is kept for historical provenance and
// stops being runnable once packages/draht-tools/bin/draht-tools.cjs is gone.
//
// # Fidelity proof (already performed for this port)
//
// Re-rendering the extracted template against a real, CJS-produced MAP.json
// (1,479 modules, this repo) reproduced the CJS-produced MAP.html
// byte-for-byte (4,153,199 bytes, 2,019 lines). See
// TestTemplateChecksum / TestEmbedJSON_EscapesAngleBrackets for the narrower,
// repo-independent guarantees checked on every build.
package htmlview
