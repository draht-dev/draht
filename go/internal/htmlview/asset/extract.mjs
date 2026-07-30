#!/usr/bin/env node
// extract.mjs lifts the MAP.html viewer template out of draht-tools.cjs's
// visRenderHtml function VERBATIM and writes it to viewer.html.tmpl with the
// two dynamic interpolations replaced by stable tokens.
//
// Why evaluation, not a source-line copy: the template literal in the CJS
// source contains escaped sequences (\\s, \\n, \\x60, ...) that must
// COLLAPSE the way the JS engine collapses them inside a real template
// literal (e.g. source `\\s` -> rendered `\s`). A sed/awk copy of the source
// lines would preserve the double backslash and silently produce a viewer
// whose embedded regexes and string joins are wrong (see cjs lines 3319,
// 3803, 4603, 4764, 4766, 4976). Evaluating the literal via `(0, eval)` is
// the only way to get byte-identical output to what the CJS engine itself
// would emit.
//
// Usage: node extract.mjs <path-to-draht-tools.cjs> <output-dir>
//
// Re-run this whenever visRenderHtml's static template changes upstream,
// then re-verify byte-fidelity against a freshly generated MAP.html (see
// go/internal/htmlview/doc.go for the recipe).

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";

const [, , cjsPathArg, outDirArg] = process.argv;
if (!cjsPathArg || !outDirArg) {
	console.error("usage: node extract.mjs <path-to-draht-tools.cjs> <output-dir>");
	process.exit(1);
}
const CJS = path.resolve(cjsPathArg);
const OUT_DIR = path.resolve(outDirArg);

const src = fs.readFileSync(CJS, "utf-8");
const fnAt = src.indexOf("function visRenderHtml(");
assert(fnAt !== -1, "visRenderHtml not found");
const retAt = src.indexOf("return `", fnAt);
assert(retAt !== -1, "return \\` not found after visRenderHtml");
const tickStart = retAt + "return ".length; // index of the opening backtick
const endAt = src.indexOf("\n`;\n}", tickStart); // index of the newline before the closing backtick
assert(endAt !== -1, "closing \\`;\\n} not found");
let literal = src.slice(tickStart, endAt + 2); // includes both backticks

// Assert exactly two interpolations, and exactly these two.
const interps = literal.match(/\$\{[^}]*\}/g) || [];
assert.strictEqual(interps.length, 2, `expected 2 interpolations, found ${interps.length}: ${JSON.stringify(interps)}`);
assert.strictEqual(interps[0], "${embeddedJson}");
assert.strictEqual(interps[1], '${JSON.stringify("./" + jsonName)}');

const T_JSON = "@@DRAHT_EMBEDDED_MAP_JSON@@";
const T_PATH = "@@DRAHT_JSON_PATH@@";
literal = literal
	.replace("${embeddedJson}", T_JSON)
	.replace('${JSON.stringify("./" + jsonName)}', JSON.stringify(T_PATH));

// eslint-disable-next-line no-eval -- deliberate: collapses JS string escapes
// exactly as the real template literal would when interpreted by V8.
const template = (0, eval)(literal);
assert.strictEqual(template.split(T_JSON).length, 2, "T_JSON token not unique in template");
assert.strictEqual(template.split(T_PATH).length, 2, "T_PATH token not unique in template");

fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, "viewer.html.tmpl");
fs.writeFileSync(outPath, template, "utf-8");

console.log(`wrote ${outPath} (${Buffer.byteLength(template, "utf-8")} bytes, ${template.split("\n").length - 1} lines)`);
