# tree-sitter vs regex parser: a categorized `edges[]` diff

**G6 deliverable.** This is the graph-pipeline-level (not per-snippet) diff
between `graph.Build(..., Parser: parse.NewTreeSitter(...))` (the default,
D2's 6-grammar subset) and `graph.Build(..., Parser: parse.NewRegex())` (the
`--parser=regex` byte-parity oracle), run over this actual monorepo
(`scan.FindRepoRoot` from `go/internal/graph`, i.e. the real
`draht-graph-go` worktree — not a synthetic fixture; every example below is
a real line in this repo, quoted and grep-verified at the time this
document was written).

`parse/differential_test.go` covers the SAME two parsers at the snippet
level (5 inline TS/JS/Python/Go/Rust examples chosen to exercise specific
grammar features) and is a useful unit-level regression net, but it is not
this document: it never runs the full pipeline (resolver, edge assembly) or
sees real-world code, so it cannot surface the systemic patterns below —
those only show up at scale, across real files.

## How this was produced

A throwaway test (not committed — its output is this file) ran `Build`
twice over `scan.FindRepoRoot(".")`'s resolved repo root, once per parser,
counted `(from, to, kind)` edge-tuple multisets on each side, and diffed
them. Every category below was then verified by hand: `grep`-ing the
specific file/specifier pair back to its exact source line, to confirm the
REASON for the divergence rather than just asserting it exists.

## Summary

| | tree-sitter | regex |
|---|---|---|
| total edges | 6235 | 6205 |
| present only on this side | 118 | 88 |

118 edges appear ONLY under tree-sitter; 88 appear ONLY under regex. Every
one of the 206 falls into one of the four categories below — three of them
are the regex parser's KNOWN, DOCUMENTED limitations (real code tree-sitter
correctly extracts and regex cannot); the fourth is the regex parser's
converse mistake (text tree-sitter correctly IGNORES and regex
false-positives on). None of the 206 represents a tree-sitter miss of real,
executable import code — this is the "correctness" advantage the whole
Phase-1 rewrite is built on, demonstrated at real-repo scale.

## Only-tree-sitter (118): real code the regex parser cannot see

### A. `export type { X } from "mod"` — type-only re-exports (~82 of 118, the majority)

`regex.go`'s `reNamedReExport` is
`` export\s+\{([^}]+)\}\s+from\s+["']([^"']+)["'] `` — it requires the
literal token `export` immediately followed by whitespace then `{`. The
`type` keyword in between (`export type {`) breaks that match; there is no
second CJS pattern that tolerates it.

Verified example — `packages/rlm/src/index.ts:16-17`:
```ts
export type { InputSource, LoadedInput } from "./loaders.js";  // regex: NOT matched (only-tree-sitter)
export { loadInput, parseInputArg } from "./loaders.js";        // regex: matched (present on both sides)
```
Both lines resolve to the same target module (`packages/rlm/src/loaders.ts`)
so this exact case doesn't change which files are *connected* in the graph —
it changes the tree-sitter side's edge COUNT for that pair by +1 (one
`re-export` edge, not two, on the regex side), which is why this shows up as
a per-edge-tuple multiset delta.

### B. Bare side-effect imports — `import "mod";` (~36 of 118)

`regex.go`'s `reImportFrom` requires a `from "..."` clause; the file's own
comment already documents this: *"side-effect-only imports... are NOT
matched by this regex — verbatim CJS behaviour: visParseImports has no
separate pattern for bare `import "x";`"*. Tree-sitter's query
(`(import_statement source: (string (string_fragment) @source)) @stmt`) has
no such restriction — any `import_statement` with a source matches,
clause or no clause.

Verified example — `packages/ai/src/images.ts:1`:
```ts
import "./providers/images/register-builtins.ts";
```
Also verified in this module's own end-to-end fixture,
`testdata/fixture-repo/packages/app/src/main.ts`'s final line
(`import "./missing";`), which is exactly why that line is there — see
`pipeline_test.go`'s `sawUnresolvedMissing` assertion.

## Only-regex (88): text the regex parser mistakes for real imports

### C. TypeScript inline type-import queries — `import("mod").Type` / `typeof import("mod")` (~30 of 88)

TypeScript lets you reference another module's type WITHOUT a value-level
import, using call-expression-shaped syntax inside a type position:
`typeof import("node:fs")`, `(x as import("bun").FileSink)`,
`AsyncGenerator<import("@draht/ai").AssistantMessageEvent>`. Textually this
looks identical to a real dynamic `import(...)` call, so `regex.go`'s
`reRequireOrDynamic` (`` (require|import)\s*\(\s*["']([^"']+)["']\s*\) ``)
matches it. Tree-sitter does not: its dynamic-import pattern anchors on
`call_expression function: (import) ...` — a real AST call-expression node
— and a type-position `import(...)` query is a distinct grammar production,
never a `call_expression`, so the query correctly never visits it.

Verified examples:
- `packages/ai/src/env-api-keys.ts:2-22` — six occurrences of
  `typeof import("node:fs")` / `typeof import("node:os")` /
  `typeof import("node:path")`, none a real import (the file lazily
  `import()`s these for real elsewhere, which — being an actual call —
  matches on BOTH sides and so never appears in this diff at all).
- `packages/router/src/router.ts:72,89,107,108,120` — five occurrences of
  `import("@draht/ai").AssistantMessageEvent` inside generic type
  parameters and a local variable's type annotation.
- `packages/gateway/src/session/session-process.ts:121-122` —
  `(stdin as import("bun").FileSink)`.

### D. Text inside string/template literals (~58 of 88)

Test fixtures, code-generation scripts, and prompt text legitimately
contain the SUBSTRING `import ... from "..."` / `require("...")` /
`export * from "..."` as literal string DATA — generated source being
written to a file, or an example shown to an LLM — not real imports of
*this* file. `regex.go` operates on raw bytes with no concept of "inside a
string literal"; it matches the substring wherever it occurs. Tree-sitter's
query only ever visits real AST statement/call nodes; text inside a
`template_string`/`string`'s `string_fragment` child is never presented to
the import query at all (it's the string's VALUE, not a sibling statement).

Verified examples:
- `packages/coding-agent/test/package-command-paths.test.ts:257` (and 5 more
  occurrences at lines 294/511/562/608/703) — a template literal building a
  helper script to write to disk for a test:
  `` `const fs=require("node:fs");fs.writeFileSync(...)` ``.
- `packages/ai/scripts/generate-image-models.ts:137-140` — a template
  literal that IS the generated file's source text:
  `` `// ...\n\nimport type { ImagesApi, ImagesModel } from "./types.ts";\n\n...` ``.
- `packages/web-ui/src/prompts/prompts.ts:29` — literal example code shown
  in an LLM prompt string: `` Chart.js: const Chart = (await
  import('https://esm.run/chart.js/auto')).default; ``.
- `packages/coding-agent/test/gsd-domain-fixture.test.ts:25-26` — a test
  assertion checking generated barrel-file CONTENT:
  `` expect(barrelSource).toContain('export * from "./Order.js";') ``.

## Net effect on `stats.edges`

Categories A/B (tree-sitter-only) and C/D (regex-only) partially offset
each other in the raw total (6235 vs 6205, net +30 for tree-sitter), but
they are not the same edges — a byte-exact "just add N" mental model is
wrong. The parity test (`parity_test.go`) sidesteps this entirely by
comparing the CJS engine specifically against Go's `--parser=regex` mode
(the parser explicitly documented as CJS's byte-parity oracle), never
against the default tree-sitter parser — which is BY DESIGN richer/more
correct than the CJS baseline, not parity-equivalent to it.
