# Knowledge-Graph Integration — Implementation Spec (v2, review-corrected)

Make Draht's `map-codebase` more like **graphify** (queryable knowledge graph + skimmable report)
AND wire graph queries into **every** Draht workflow command + skill, replacing blind file-tree
scanning with cheap, deterministic graph queries.

Scope: **Focused** + data-driven clusters + git post-commit auto-rebuild + viz upgrades.
**No** MCP server, Leiden, LLM/embedding semantic search, concept/topic extraction, media ingestion.

**Parity statement.** Reproduced: typed module+symbol nodes; import/re-export/call/container edges
with `EXTRACTED`/`INFERRED`/`AMBIGUOUS` confidence; god-nodes; label-propagation neighborhoods;
surprising/bridge connections; inline rationale (NOTE/WHY/HACK…); keyword+doc query; shortest path;
blast-radius; git-hook auto-rebuild; **GRAPH_REPORT.md**. Deliberately omitted: LLM/embedding
semantic search (the deterministic `graph-*` CLI is the substitute), Leiden, topic nodes, media, MCP.

Canonical source: `packages/draht-tools/bin/draht-tools.cjs`. After editing, run
`node scripts/sync-draht-tools.mjs` (copies ONLY this file → 3 consumer bin/ copies). The builder is
`visBuildMap(root)` (~1674-2493) emitting MAP.json **schemaVersion 3** → bump to **4**. All additions
are additive (no renamed/removed fields).

## Hard invariants
- **Determinism is load-bearing** (MAP.json is git-committed): every ranking/cluster/list must be
  byte-identical across runs. Sort with explicit secondary tie-break (… THEN `id` asc). Dedup edges.
  Stable synthetic ids. No `Date`/insertion-order leakage into ordering.
- **Backward compatible**: only additions; consumers must treat new fields as optional (`|| []`).
- **MAP.json must stay < ~1.5× its v3 size** (v3 is ~2.65 MB / 1237 modules here). Enforce the caps below.
- **Query commands are READ-ONLY**: they never rebuild/mutate MAP.json (would dirty the git tree after
  every pull/checkout). If MAP.json is absent → print `no map — run <inv> map-graph` and exit 0.
- Dependency-free, single-file CommonJS. No new file reads in enrichment (reuse `perFile` raw content).
- Dispatcher passes args **positionally** (`commands[cmd](...args)`, line 4039). Every new command parses
  its own `args` array (the `map-serve` pattern, 3857-3867) — never named params; flags interleave.

---

## Part A — MAP.json enrichment (in `visBuildMap`)

### A1. Rationale (`rationaleIndex` only; optional small per-module copy for HTML)
Add a **per-language comment-span extractor** (invert the existing strip logic at 1747-1749 to KEEP
comments): TS/JS `//` + `/* */`; Python/shell `#`; SQL `--`; HTML/MD `<!-- -->`. Raw content is
`perFile.get(rel).content` (also stored — misnamed — as `.stripped` at 1791). Run the tag regex ONLY
over extracted comment text (prevents false positives on `const TODO_LIST` / `throw Error('FIXME')`):
`/\b(SECURITY|BUG|FIXME|HACK|XXX|TODO|WARNING|GOTCHA|PERF|NOTE|WHY)\b\s*[:\-]?\s*(.+)/`.
- Top-level `rationaleIndex = [{ file, line, tag, text }]`, text ≤120 chars, **cap 600**, sorted by tag
  severity (SECURITY>BUG>FIXME>HACK>XXX>WARNING>GOTCHA>PERF>TODO>NOTE>WHY) then file then line.
- `modules[*].rationale`: keep ONLY for HTML use — **cap 5/file**, text ≤80 chars (or omit and have
  graph-context filter `rationaleIndex` by file). Decision: omit per-module; graph-context filters the index.
Confidence: `EXTRACTED`.

### A2. Symbol nodes (`modules[*].symbols`) — `line` already exists, do NOT touch `visExtractExports`
`visExtractExports` already emits `{name,kind,line,doc}` for all languages (verified). Work:
- (a) In the per-file loop, build `m.symbols` from the **untruncated** local `exports` var BEFORE
  `exports.slice(0,30)` (1772) — else 31+ symbols are lost. Each symbol `{name,kind,line,exported:true}`
  — **no `doc`** (doc stays on `m.exports[*].doc`; graph-query joins to it). Cap **60/module**.
- (b) Add a cheap non-exported top-level decl pass over `perFile.get(rel).content` (already in memory):
  regex top-level `function NAME`/`class NAME`/`const NAME =`/`def NAME`/`func NAME` NOT preceded by
  `export`/`pub` → `{name,kind,line,exported:false}`. Dedup vs exported names. Counts toward the 60 cap.
- (c) `symbolIndex` (existing flat, **exported-only**) push at ~2425: add `line` + `exported:true`. Keep
  its exported-glossary semantics + existing 1500 cap (do NOT change semantics).
- **graph-query (B5) and glossary seeding (E.init-project) route over `modules[*].symbols`, NOT the
  capped `symbolIndex`** (the cap saturates at 1501 on this repo and hides later modules).

### A3. Confidence tags (covers all three existing edge kinds)
- `edges` kind `import`|`re-export` → `confidence:"EXTRACTED"` (resolved via resolveSpec).
- `edges` kind `external` → `confidence:"EXTRACTED"`, add `resolved:false` (the import IS in source;
  NOT AMBIGUOUS — don't mistrain agents against normal deps).
- `callEdges` → `confidence:"INFERRED"` (regex call-site heuristic). If a call-site matched ONLY via the
  member-call form `local.x(` (not a direct `local(`) → `confidence:"AMBIGUOUS"` (member→symbol mapping
  is genuinely uncertain). Detect with two regexes at ~1893.
- `containerEdges` → `confidence:"EXTRACTED"`.

### A4. Hotspots (`hotspots`) — non-test degree, deterministic
Build **non-test** degree maps `inDegNT`/`outDegNT` over `kind:'import'` edges where the `from` module
is NOT a test (so test imports don't inflate "most depended-on"). Over non-test modules:
- `godNodes`: top by `inDegNT*2 + outDegNT + log2(1+loc)`.
- `mostDependedOn`: top by `inDegNT`. `orchestrators`: top by `outDegNT`. `largest`: top by `loc`.
Each `{ id, path, package, inDegree, outDegree, loc, score, reason }`. **Limit 15 each. Tie-break:
score desc THEN id asc** (integer scores tie constantly). Also fix the pre-existing missing tie-break in
`computeTopFiles` (1977). Degree counts exclude `re-export`/`external` (barrels aren't god-nodes); note this.

### A5. Clusters (`clusters` + `modules[*].cluster`) — deterministic async label propagation
Undirected adjacency `Map<id, Set<id>>` over resolved `kind:'import'` edges (both endpoints in
`moduleByRel`): add both directions, **dedup** (Set), exclude self-edges.
- Init each node label = its id. **ASYNC** propagation in **fixed sorted-id order**, max 10 passes: each
  node adopts the most-frequent label among neighbors; ties → lexicographically smallest label. Stop on
  no-change or pass cap.
- Group by final label. **Stable cluster id = `cluster:` + min(sorted member ids)**. Label = dominant
  package (sorted-name tie-break); if multi-package, `<top-level-dir> · <dominantLayer>`.
- **Every module gets `cluster`**: nodes with no import edges (singletons, non-JS/TS Python/Go/Rust,
  md/json/yaml) → per-package fallback cluster `cluster:pkg:<name>` / `cluster:dir:<d>` (never undefined).
- **Collapse guard**: if largest cluster > 50% of non-test modules → discard LPA result, fall back to
  package-based clustering via `containerOf`.
- `clusters = [{ id, label, size, members:[ids], dominantPackage, dominantLayer, packages:[…] }]`, sorted
  size desc then id asc. Note in agentHints: clusters are **structural** (import topology), not semantic.

### A6. Surprising connections (`surprisingConnections`) — cluster-bridge, O(E)
Substrate = **import edges crossing clusters** (module-level; NOT package-level containerEdges).
Precompute `Map<'cA→cB', count>` in one O(E) pass. For each cross-cluster import edge, score:
- `+2` if it crosses a **layer** boundary in the wrong (outward) direction. Canonical inward order:
  `presentation→application→domain→infrastructure`; reverse = violation. `support` excluded (unordered).
- `+2` if it is a **bridge** (its cluster-pair count ≤ 1 — only edge connecting those clusters).
- `+1` if it crosses functional **groups** (`containers[*].groupId`).
- weight by inverse symbol frequency (rare coupling = more surprising).
Aggregate per cross-cluster module-pair; output top **20** `{ from, to, reason, score, sampleSymbols }`
(sampleSymbols from callEdges between the pair). Sort score desc then `from` asc.

### A7. agentHints + bug fix
Add `howToUse` lines for `symbols`, `confidence`, `hotspots`, `clusters`/`cluster`,
`surprisingConnections`, `rationaleIndex`, and a **"query with `<inv> graph-*` instead of reading the
whole file"** pointer. Bump `schemaVersion:4`. **Fix the `deriveGroups` cwd bug**: it reads
`path.join(process.cwd(), …)` (1149) — pass `root` in and use it (groups/clusters/surprising now depend
on stable group classification).

### A8. GRAPH_REPORT.md (NEW — the signature graphify artifact)
Emit in `visWriteOutputs` (~3835) alongside MAP.json/MAP.html; regenerated by `map-graph` **including
under `--quiet`** (only the HTML render is gated by --quiet). Deterministic Markdown (~150 lines of
string-building, no LLM), all from precomputed fields:
- Header: `Generated by draht-tools map-graph. Do not edit; regenerated each build.`
- **Overview** (stats one-liner). **Key concepts** (top clusters: label · dominantLayer · size · sample
  members). **God nodes** (hotspots.godNodes top ~8 table: path / in / out / reason). **Surprising
  connections** (top ~10: from→to · reason · sampleSymbols). **Rationale highlights**
  (rationaleIndex filtered to SECURITY/BUG/FIXME/HACK). **Suggested questions** (templated over top
  findings: "Why does `<godNode>` have N dependents?", "Is the bridge `<from>`→`<to>` intended?",
  "Should `<HACK file:line>` be addressed?").
Headline it in map-codebase's "Living map for agents" section.

---

## Part B — Query CLI (`graph-*`, read-only)

Helper `loadMap(dir)`: read `<dir>/.planning/codebase/MAP.json`; return null if absent. NO rebuild.
Each command: parse own `args` (flags `--json`, `--depth N`, `--limit N`, `--surprising` interleave with
file positionals); fuzzy-match unknown file args against module paths (basename/suffix); **concise text
default**, `--json` for full data. If no map → `console.log("no map — run <inv> map-graph")`, return.

1. **`graph-context <file...>`** — ≤7 lines/file (hard). Per file:
   `<path> · pkg:<pkg> · layer:<layer> · cluster:<label>(<size>) · entry:<yes/no>` /
   `exports(n): a,b,c,d` / `importers(n): top5 (+N more)` / `imports(n): top5 (+N more)` /
   `sinks: …` / `rationale(n): SECURITY:42 … · HACK:88 …` (filtered from rationaleIndex by file).
   Cap importers/imports to **top 5**. One block per file.

2. **`graph-impact <file...>`** — ≤25 lines, **RISK SUMMARY FIRST**. Reverse-BFS over `kind:'import'`
   edges from targets → reverse-dependent set; `entryPoints.filter(ep => reachable.has(ep.id))` (exact,
   O(V+E) — NOT `depth`/`flows`). Print: `impact <path> — N modules · M packages · K entry points ·
   sinks: …` / `entryPoints reaching it (k): …` / `by package: pkg(n): top5 (+rest)` /
   `clusters affected: …` / `⚠ boundary: <wrong-direction crossings>`. **Never print >~30 module names**
   — collapse remainder to per-package counts. Full set via --json.

3. **`graph-callers <file> [--depth N]`** / **`graph-callees <file> [--depth N]`** — direct + N-hop
   (default 1) via callEdges + import edges, with symbol(s) used.

4. **`graph-path <from> <to>`** — shortest path (BFS over import edges; if none, try reverse and label
   it `reached-by`). Print the chain in the **direction actually traversed** with the hop symbol when known.

5. **`graph-query <text...>`** — ranked keyword+doc search over `modules[*].symbols` (join doc from
   `m.exports`). Per term, per symbol: `400` name==term · `200` startsWith · `100` includes ·
   `60` path-basename includes · `40` doc includes (with crude stem: strip trailing s/ing/ed/tion) ·
   `30` cluster/container label includes · else 0. Multiplier ×1.5 if exported, ×1.3 if entryPoint
   (once, on best per-term sum). total = Σ over terms of max-per-term. **AND-ish**: drop a candidate
   scoring 0 on any term ≥3 chars. Ignore terms <3 chars; lowercase both sides. **Top 15**, 1 line each:
   `<path>:<line>  <kind> <name>  — <doc≤60>  [exported]`. Tie-break: (inDeg+outDeg) desc → shorter path
   → path asc. Echo a `resolved 'x' → …` line only on inexact match.

6. **`graph-hotspots [--limit N]`** — print godNodes / mostDependedOn / orchestrators / largest.

7. **`graph-clusters [--surprising]`** — clusters (label · size · dominant pkg/layer · sample members);
   `--surprising` appends `surprisingConnections`.

Register all in help text (~3983); README + AGENTS.md get the list.

---

## Part C — Insights view (4th HTML view)
Edit the **four** coupled sites: (1) tab-id array in `setView` (2776) AND the same list in `selectFlow`
(~2808); (2) render dispatch if/else (3152-3154) → add `else if (state.view==='insights')
renderInsights(...)`; (3) keyboard handlers (3799-3806); (4) tab DOM (2660-2663) + keybinding.
Insights renders: **Clusters** (modules colored by `cluster`, legend of labels), **Hotspots** (god-nodes
sized larger; ranked side list, click → highlight callers/callees via `buildAdj`/`buildReverseAdj`),
**Surprising connections** (drawn in a hot color, tooltip = reason+score). Treat
`clusters/hotspots/surprisingConnections/modules[*].cluster` as **optional `|| []`** (map-serve may serve
a stale v3 MAP.json with new HTML). Do not regress System/Modules/Flows.

---

## Part D — Freshness / git auto-rebuild
1. **`map-graph [dir] [--quiet]`** — parse own args; `--quiet` skips `visRenderHtml` (still writes
   MAP.json + GRAPH_REPORT.md); don't mistake `--quiet` for `dir`.
2. **`graph-hook install|uninstall|status`** — manage `.git/hooks/post-commit`: idempotent marked block
   `# >>> draht map-graph >>>` … `# <<< draht map-graph <<<` running
   `node <abs path to this draht-tools.cjs> map-graph --quiet 2>/dev/null || true`; preserve existing
   content; chmod +x. uninstall removes only the block; status reports. Regenerated MAP.json/REPORT land
   in the working tree for the NEXT commit (two-commit lag, no loop — visWalk ignores `.planning`).
3. **gsd-post-phase.cjs** (edit BOTH `packages/{draht-claude,draht-codex}/scripts/gsd-post-phase.cjs`
   directly — they are byte-identical but NOT sync targets; keep identical): after a phase, **guarded**
   refresh — only if `.planning/codebase/MAP.json` already exists; run `map-graph --quiet`; never fail
   the hook (`|| true`). **This hook is the SINGLE GRAPH-REFRESH owner.**

---

## Part E — Workflow integration (core deliverable)

Principle: **graph-first orientation** — any step that greps/walks/"finds relevant files"/"analyzes the
codebase"/"identifies affected modules" gets a preceding graph query. Edit BOTH
`packages/draht-claude/commands/*.md` AND `packages/draht-codex/commands/*.md` (separate files, different
phrasing: Claude="Task subagent", Codex="Codex subagent"; the per-file Tool note defines the invocation).
**≤4 lines per insert**, concrete command, real step numbers.

### Guardrails (from review — do NOT violate)
- **DO NOT edit `packages/draht-codex/skills/<cmd>/SKILL.md`** per-command wrappers — they are 15-line
  pointers to `commands/<cmd>.md` and inherit graph steps automatically. Editing them is over-reach/drift.
- Snippets use **`<inv>` = the draht-tools invocation from THIS file's Tool note**, never bare
  `draht-tools` (not on PATH → "command not found"). Each command file already defines the prefix.
- **Subagents cannot run draht-tools** (plan-phase.md:58). For subagent-facing steps, the ORCHESTRATOR
  runs the query and **pastes the summary into the subagent prompt**.
- Each command keeps a **self-contained** 1-2 line invocation (commands don't auto-load the gsd-workflow
  skill). The gsd-workflow reference block is supplementary discoverability, not a substitute.

### Canonical snippets (adapt tense/agent-noun per file)
- **GRAPH-ORIENT**: "Before scanning the tree, orient via the living map. Run `<inv> graph-context
  <files>` for the area you're touching and `<inv> graph-query "<concept>"` to locate code. If
  `.planning/codebase/MAP.json` is absent, run `<inv> map-graph` first. Prefer these over `grep`/`find`."
- **GRAPH-IMPACT**: "Run `<inv> graph-impact <changed-files>` for the blast radius (reverse-dependents,
  affected entry points, downstream sinks, crossed bounded contexts). Use it to (a) parallelize only
  plans/tasks with disjoint impact sets and (b) flag layer/boundary violations. For subagents, the
  orchestrator runs it and pastes the summary into the prompt."
- **GRAPH-REFRESH** (guarded fallback only; the post-phase hook owns refresh): "Run `<inv> map-graph
  --quiet` to refresh MAP.json if it is older than HEAD (skip if the post-phase hook already refreshed)."

### Per-command plan (corrected step numbers; ✕ = skip)
| Command | Edit |
|---|---|
| fix | Phase1: GRAPH-ORIENT + `graph-callers <buggy-file>` (supports "trace UPWARD", fix.md:57). Phase2: graph-query HALF only — find working examples, replacing manual scan (fix.md:69). Drop Phase3/Phase4 gates. |
| plan-phase | Step3d (artifact mapping): GRAPH-ORIENT. Step4 (independent plans, line 52): GRAPH-IMPACT. Step5: orchestrator runs graph-context, pastes slice into architect prompt. |
| execute-phase | Step2 (parallel/sequential): GRAPH-IMPACT. Per-task: orchestrator MAY paste a graph-context slice (optional, not mandatory template line). NO end-of-phase refresh (hook owns it). |
| verify-work | Step0.5: GRAPH-REFRESH guarded fallback. Frame graph layer check as EVIDENCE for the existing DOMAIN.md boundary check (verify-work.md:50-54); orchestrator pastes graph-impact summary into reviewer prompt. |
| review | Step2: orchestrator runs graph-context+graph-impact on changed files; paste crossed-context/boundary summary into reviewer prompt. |
| quick | Optional: orchestrator graph-context before implementer; graph-impact boundary summary into review prompt. |
| orchestrate | For **code-touching** sub-tasks only: graph-impact to test independence + ordering. |
| next-milestone | GRAPH-REFRESH (guarded) + drift compare (clusters/contexts/entry points vs milestone start) + `graph-clusters --surprising`. |
| init-project | Step2: ALSO run `map-graph` (the map-codebase TOOL doesn't). Step3: read MAP.json + `graph-hotspots`/`graph-clusters`; seed glossary from `modules[*].symbols`. |
| map-codebase | Headline GRAPH_REPORT.md in "Living map" section; add the `graph-*` commands + Insights view; offer `graph-hook install`. |
| discuss-phase | UPGRADE: `graph-context` + `graph-clusters` on the area being discussed (before planning). |
| brainstorming(cmd n/a) | — |
| new-project | Light: after Phase 1 code exists, run `/map-codebase`. |
| progress | ✕ (ceremony). |
| pause-work | ✕ (ceremony). |
| atomic-commit | ✕ (git-only). |
| resume-work | Optional: validate MAP not drifted during pause. |

### Skills (edit the 7 REAL discipline skills, both platforms IF codex copies are real content — verify;
do NOT touch codex per-command wrappers)
| Skill | Edit |
|---|---|
| gsd-workflow | Add `.planning/codebase/MAP.json` + GRAPH_REPORT.md + the `graph-*` command list to structure/per-phase cycle. Host the **"Graph-first orientation"** reference block. |
| ddd-workflow | Use `graph-clusters`/`graph-context` to surface candidate bounded contexts (NOTE: structural ≠ semantic — confirm with human); post-phase drift check vs DOMAIN.md; seed ubiquitous language from `modules[*].symbols`. |
| debugging-workflow | Phase1.5: graph-context + graph-callers. Phase2: graph-query instead of grep. Use graph-impact to avoid regression. |
| atomic-reasoning | Validate decomposition vs MAP (same cluster/context? graph-context); atomicity heuristic: files in one bounded context. |
| tdd-workflow | Use MAP layers/clusters to target coverage; task `<files>` should be one context (graph-context check). |
| verification-gate | Add "architecture sound" evidence row: run `map-graph` + check `surprisingConnections`/cross-context violations. |
| brainstorming | Light: if an existing codebase, run map-codebase + graph-hotspots first. |

---

## Part F — Docs / sync / verify
- Update `packages/draht-tools/README.md` + root `AGENTS.md` with the `graph-*` list + GRAPH_REPORT.md.
- `node scripts/sync-draht-tools.mjs`; `node scripts/check-draht-customizations.mjs` if it validates parity.
- Verify on THIS repo: `map-graph`; confirm schemaVersion 4, all new fields, MAP.json < 1.5× v3 size,
  **run map-graph twice and `diff` the two MAP.json — must be byte-identical** (determinism gate);
  exercise every `graph-*` command; open MAP.html Insights view; check GRAPH_REPORT.md reads well.
