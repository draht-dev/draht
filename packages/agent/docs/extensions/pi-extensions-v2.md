# pi extension system v2 — design notes

Status: **exploratory**. A working document, not a spec. Records what we learned
from other harnesses, what we take and reject, and the current shape. Expected to
change. `../plugins.md` and `../plugin-reloading.md` supersede its service-dependency,
reload, and rollback discussion where they conflict.

---

## 1. Sources

### Ours

| Doc | Status | What it settles |
|---|---|---|
| `harness.md` | current | Durable session runtime: storage, tree, lanes, operations, hooks, events, restore. **Supersedes the two below wherever they conflict.** |
| Remote session vertical slice | current | Supervisor process model: stable server ID, Unix socket, process-per-session, replacement with handoff. |
| `plans/pi-server.md` | superseded, still useful | Snapshot+delta discipline, state taxonomy, server/client split, missing-events inventory. |
| `plans/pi-extensions.md` | superseded, still useful | Runtime split, manifest + multiple factories, `api: "major.minor"`, web asset serving, dogfooding rule. |

Read the superseded pair for *why*; read `harness.md` for what exists.

### External

- **opencode** `packages/plugin/src/v2/effect/PLAN.md` — transform/hook/rebuild.
  Short, and the most directly applicable document in the set.
- **bb** `packages/plugin-sdk/src/app-contract.ts` and
  `apps/server/src/services/skills/builtin-skills/bb-plugin-authoring/SKILL.md` —
  slots, atomic reload with rollback, bundle serving.
- **deepseek-harness** `packages/bundle/base/cordis.patch.yml`,
  `packages/client/ui-layout/src/client/index.ts`, `vendor/loader/src/internal.ts`
  — "everything is a plugin" at full commitment, plus the ESM-internals reload trick.
- **eve** `docs/concepts/execution-model-and-durability.mdx`, `docs/extensions.md`,
  `packages/eve/src/compiler/module-map.ts` — `defineState`, namespace-on-mount,
  compile-to-module-map.
- Cordis paper (*A Programming Paradigm for Spatiotemporal Composability*) — skim.
  §6.1 (system boundary), §6.5 (granularity), §6.6 (dependency typing) are the
  honest parts. The metatheory is not load-bearing for us.

---

## 2. What the others do

### DeepSeek harness (Cordis)

Everything is a plugin, literally: ~200 npm packages composed by layered YAML.
`bash`, `fs`, the system prompt, session persistence, the agent loop are config
rows. The UI is ~35 more plugins with an open typed slot system where declaring a
slot claims render authority over it.

Effects revert by running stored inverses (`ctx.effect(setup)` returns a disposer).
Dependencies declared (`inject`/`provide`), resolution reactive.

Module loading reaches into Node internals:
`require("internal/modules/esm/loader").getOrInitializeCascadedLoader()`, walks
`job.linked`, deletes from `loadCache`. Version-branched for Node 22 (`v1`) vs 24
(`v2`); needs `--expose-internals` or a native addon.

**Observed:** 218 of 342 `inject` declarations are one cross-cutting service; the
real graph is ~60-80 edges, nearly all core-to-core. Component props are a
four-way type intersection. **HMR is disabled for the web profile.**

**Verdict:** composition-as-config is genuinely good. 200 packages, cross-package
typing, and an inverse-correctness obligation per author are not.

### bb

One backend tier that always runs. A plugin is a package with `server` and
optional `app` entries, per-plugin SQLite, KV namespace, RPC namespace, auth
token. **No inter-plugin dependencies at all.**

Registrations return `void` because they are **host-owned and load-scoped** — the
host drops the whole per-plugin bucket on reload. `onDispose` covers only what
escapes that bookkeeping.

Reload is atomic: run the factory against a *candidate* set; on failure the
previous set stays live entirely; on success abort background services with a
bounded await, dispose LIFO, drain in-flight handlers, close DB handles,
invalidate the old handle (stale use throws), swap wholesale.

Slots are a fixed host enum, additive by default. One exclusive slot, arbitrated
by a user setting with a built-in fallback. Content scripts get an `AbortSignal`.

**Verdict:** the most practically useful of the four.

### opencode

*Internal and external plugins use the same public API.* Core provider adapters
and config domains are written as plugins. Two verbs:

- `transform` — replayable contribution to a domain
- `hook` — intercept a live operation

Plus `rebuild()`. A domain is rebuilt by replaying every active transform over a
fresh draft. Removing a plugin = drop its transforms, rebuild.

Rebuilds fire on registration, disposal, explicit `rebuild()`, and once after bulk
boot. Serialized and coalesced; each snapshots its list at start. Reentrancy
banned. Same-ID replacement retains order position and disables the old first.

`PluginContext` is **closed** — `agent`, `aisdk`, `catalog`, `command`,
`integration`, `plugin`, `reference`, `skill`, `options`. No `provide`/`use`, no
service registry, no Effect Layers exposed. The domain list is the entire surface.

Runs on Bun, so `.ts` imports natively. "Whole-Location generation reload" is a
**Deferred Decision** — they do not reload modules; they replay transforms.

**Verdict:** this is the model.

### eve

Filesystem-first, no registration API: `agent/tools/*.ts`, `agent/hooks/*.ts`,
`agent/channels/`, `agent/schedules/`. Slug = path basename.

Durability delegated to Workflow SDK; `"use step"` marks a durable step. Pluggable
"worlds" (local disk, Vercel, postgres). session -> turn -> step.

Loading is **compiled**: `packages/eve/src/compiler/module-map.ts` emits a
generated file of static imports keyed by node id. No runtime module loading.

`defineState(name, initial)` — a typed named slot of durable per-session memory,
auto-namespaced per extension, `get()`/`update()`.

Namespace on **mount**, not declaration: author writes `tools/search.ts`, the
consumer's mount filename makes it `crm__search`.

Compatibility metadata generated at build, checked at consumption — not npm peer
ranges.

**Verdict:** typed bound addresses and namespace-on-mount are worth taking. They
map to the ordinary `value<T>()` / `list<T>()` storage model rather than a separate
plugin-state API. The workflow dependency is not. Neither is the
filesystem-as-authoring-interface: pi has always been registration-based, that is
the idiom extension authors know, and a directory convention would break every
existing extension for no gain.

---

## 3. Steal / adapt / reject

### Steal

| From | What | Why |
|---|---|---|
| opencode | replay contributions to rebuild a registry | Correct removal by construction. No inverses, no commutativity. |
| opencode | strict contribute/intercept split | Config-shaped state and per-operation behavior are different problems. |
| opencode | same API for built-in and third-party | Makes the dogfooding rule mechanical. |
| opencode | closed context, no service resolver | Everything shared is a registry. |
| opencode | rebuild snapshots its list; reentrancy banned | Replay stays a fold, not a fixed point. |
| bb | host-owned registration buckets | Registrations need no disposers. |
| bb | candidate-then-swap reload with rollback | Failed reload leaves the previous set live, entirely. |
| bb | stale-handle error | Loud failure beats mysterious no-ops. |
| bb | fixed slot enum, additive default, user-arbitrated exclusives | Avoids competition instead of resolving it. |
| bb | `AbortSignal` into every factory | Covers timers/sockets/watchers/fetch with no new concepts. |
| eve | typed durable addresses | Fixes the string-keyed `kv` naming problem without adding a second state API. |
| eve | namespace on mount | Gives each plugin a stable collision-resistant prefix. |
| eve | compatibility metadata checked at load | Better than a manifest version field alone. |
| DeepSeek | composition as declarative config | Profiles become data; an app is a manifest. |

### Adapt

- **"Everything is a plugin"** -> yes, but internal modules from a registry table,
  not 200 published packages. Sidesteps the independent-build typing problem.
- **bb's single backend tier** -> split into supervisor + session host. Different
  lifetimes, different plugin tiers.
- **opencode's domains** -> ours are `tools`, `commands`, `providers`, `resources`,
  `settings`, and the client-side ones.

### Reject

| What | Why |
|---|---|
| `inject`/`provide` dependency resolution | Evidence says plugins rarely depend on each other; core-to-core edges are ours to wire. |
| Cordis inverse-tracking as the main mechanism | Unchecked obligation on the author. Replay is correct by construction. `effect` stays for the residue. |
| Independence / commutativity discipline | We do not need arbitrary revert order. |
| Open slot registries (DeepSeek `SlotMap`) | Cross-plugin declaration merging with no shared build. |
| Component-splitting to break cycles | Quadratic integration packages. Detect and error. |
| Confluence guarantees | Theory, not a product requirement. |
| Async contributions | opencode allows arbitrary I/O in transforms — their worst decision. Makes replay expensive and non-deterministic. |
| ESM-internals cache eviction | Works, zero-leak, two undocumented APIs plus a version branch and a native-addon fallback. |
| Compiled module map (eve) | Needs a build step. pi is a CLI. |
| Filesystem conventions as the authoring interface (eve) | pi has always been registration-based. Same file, same mental model, and existing extensions keep working. |
| Workers | Providers carry live methods on the streaming hot path. Set aside. |

---

## 4. Vocabulary

| ours | theirs | why |
|---|---|---|
| **registry** | domain | Concrete; pi already says `ModelRegistry`. |
| **contribution** | transform | A noun for a thing you add. Most contributions do not modify anything. |
| **draft** | editor | A draft is a mutable work-in-progress. |
| **build** | core finalization | One word; it is what happens. |
| **rebuild** | rebuild | Keep. |
| **commit** | commit | Keep. |
| **hook** | hook | Universal. |
| **view** | — | The one session-to-client primitive. |

---

## 5. Tiers

```
supervisor       long-lived daemon. socket, stable ID, spawn, replacement.
 +- session host  one process per session. Session + AgentHarness. cwd-bound.
     ^v sync
    client       TUI or web. one per attachment.
```

Not client/server — **where the session lives** vs **where the pixels are**. In
`pi -p`, rpc, and sdk mode the supervisor is absent and the bottom two collapse
into one process. Plugin code is identical.

Call the supervisor the **server**; do not call the session tier that.

```ts
export const manifest = { id: "todo", api: "1.0" };

export function server(pi: ServerApi) {}    // supervisor, once, global-only
export function session(pi: SessionApi) {}  // per session process
export function tui(ui: TuiApi) {}          // per TUI attachment
export function web(ui: WebApi) {}          // per browser attachment
```

Module loaded once per process; factories run per instance.

### Load scopes

| Tier | Global | Project (cwd) | Why |
|---|---|---|---|
| server | yes | **no** | One process, no cwd, outlives everything. Project code in the daemon has no containment. |
| session | yes | yes | Process-per-session bound to one cwd *is* the containment. |
| client | yes | yes | Resolved against the **session's** cwd, not the client's. |

Project code reaches the supervisor by **declaring data** a globally-installed
plugin interprets — the `.github/workflows` pattern. The repo declares; the runner
you trust executes.

### What each tier is for

**Server** — anything that must work with no session running: automations and
schedules, session-list decoration, auth and connection policy, cross-session
state, HTTP routes, discovery/relay, retention policy.

**Session** — tools, hooks, session mutation, agent behavior, plugin UI.

**Client** — components, renderers, slot contributions, keybindings. Never touches
the filesystem; its own cwd is meaningless.

---

## 6. The four verbs

```ts
interface SessionApi {
  readonly id: string;
  readonly config: JsonValue;          // resolved settings, typed

  // 1. contribute — replayable, SYNCHRONOUS
  tools:     Registry<ToolDraft, ToolState>;
  commands:  Registry<CommandDraft, CommandState>;
  providers: Registry<ProviderDraft, ProviderState>;
  resources: Registry<ResourceDraft, ResourceState>;
  settings:  Registry<SettingsDraft, SettingsState>;

  // 2. intercept — harness hooks, verbatim
  hook<K extends HookName>(name: K, h: HookHandler<K>, localId?: string): void;

  // 3. observe — harness events, passive
  on<T extends EventType>(type: T, l: Listener<T>): void;

  // 4. effect — the non-replayable residue, and where I/O lives
  effect(setup: (signal: AbortSignal) => void | Promise<void>): void;

  // core capabilities — always present, no resolution
  fs: Fs;
  credentials: Credentials;
  session: SessionOps;                 // includes bound value/list operations
  sessions: SessionsApi;
  diagnostics: Diagnostics;
  view(component: string, state: unknown, opts?: ViewOptions): View;
}
```

Registration is the existing pi idiom and stays. The only change is that a
registration lands in a replayable list instead of a mutable table:

```ts
// old
pi.registerTool({ name: "bash", ... });

// new
pi.tools.add((d) => d.set("bash", { ... }));
```

Same file, same shape, same mental model — and that is what buys removal and
reload.

### Registry shape

```ts
interface Registry<D, S> {
  add(fn: Contribution<D>): () => void;   // owner inferred from the plugin
  rebuild(): Rebuilt<S>;
  current(): S;
}

type Contribution<D> = (draft: D) => void;   // NOT Promise<void>

interface Rebuilt<S> {
  state: S;
  added: string[]; removed: string[]; changed: string[];
  errors: Array<{ owner: string; message: string }>;
}
```

```ts
function rebuild(): Rebuilt<S> {
  const contributions = [...this.contributions];   // snapshot before replay
  const draft = this.newDraft();
  const errors = [];

  for (const { owner, fn } of contributions) {
    try { fn(draft); }
    catch (e) { errors.push({ owner, message: msg(e) }); }   // skip, do not abort
  }

  const next = this.build(draft);         // host projection step
  const diff = diffState(this.state, next);
  this.state = next;
  return { state: next, ...diff, errors };
}
```

`build` is the host's finalization: `composeModelProvider` for providers, schema
validation for tools. Not a contribution, not reorderable, not droppable.

### Improvements on opencode

1. **Contributions are synchronous.** No I/O, no `await`. Their models.dev
   *example* becomes our *rule*.
2. **A throwing contribution is skipped, not fatal.** Recorded against its owner,
   replay continues. One bad plugin cannot empty the tool registry.
3. **Rebuild emits a diff.** Feeds the sync layer directly.
4. **Order is manifest order**, not registration order — deterministic,
   user-visible, reorderable by editing a file.
5. **One draft shape across registries** — `set`/`update`/`delete`/`has`/`ids`,
   with per-registry sugar on top. Learn it once.

### Draft base

```ts
interface Draft<T> {
  set(id: string, value: T): void;
  update(id: string, fn: (v: T) => void): void;   // warns if absent
  delete(id: string): void;
  has(id: string): boolean;
  ids(): readonly string[];
}
```

`update` must hand the callback a **fresh clone** per replay, or in-place wrapper
mutations accumulate across rebuilds.

### Wrapping and replacing

```ts
// replace — last contribution wins, manifest order decides
pi.tools.add((d) => d.set("bash", myBash));

// wrap — capture inside the contribution so it is rebuilt each replay
pi.tools.add((d) => {
  d.wrap("bash", (inner) => async (args, ctx) => {
    if (!(await approve(args))) return blocked();
    return inner(args, ctx);
  });
});
```

Two wrappers compose; nesting order is manifest order. Removing the middle one and
rebuilding gives exactly what you would have had without it — no unwrapping.

| | wrap | hook |
|---|---|---|
| changes schema/description the model sees | yes | no |
| targets one named tool | yes | either |
| applies to every tool | awkward | yes |
| must run when the tool does not exist | no | yes |
| runs at rebuild time | yes | no |

`d.update` on a missing id **warns**, so a wrapper degrades to a no-op rather than
breaking the registry. Diagnostics record the wrap stack:
`bash: core-tools -> metrics -> permission`.

### Where I/O runs

```
I/O -> plugin-scope variable -> rebuild() -> contribution reads the variable
```

Three places: `pi.effect(async signal => ...)` at activation, later triggers
(commands, timers, events), and `execute` at invocation. Never a contribution.

### Cross-registry reads

Allowed, untracked, and usually unnecessary:

- Read at **execute/render time** — always fine, no coupling. Prefer this.
- Read at **build time** — you own the invalidation:
  `pi.providers.onRebuild(() => pi.tools.rebuild())`. One line, same file.
- **Automatic tracking — no.** Rebuild storms (availability refreshes are
  network-backed and frequent) and cycles you would then have to detect.

Only things the *model* must see up front — tool schemas and descriptions — need
build-time embedding. That is a small set.

---

## 7. Views — the one session-to-client primitive

`broadcast`, `open`, `show`, and `channel` were four APIs answering the same four
questions with different defaults hardcoded:

1. Who sees it?
2. What is the current state? (the late-join problem)
3. Can clients talk back?
4. When does it end, and with what?

```ts
const v = pi.view("todo-panel", { items });

v.state = { items: next };     // synced to its clients
v.on((msg, from) => { ... });  // clients send back
await v.done;                  // resolves when closed, with a value
v.close(result);
```

```ts
pi.view(component, initial, {
  to: "originator" | "all" | clientId[],   // default "all"
  durable: boolean,                         // default false
})
```

| old name | is a view with... |
|---|---|
| `broadcast` | state, all clients, no messages, never closes |
| `open` / `ask` | state, originator, one message, closes with result |
| `show` | state, all clients, maybe messages, closes explicitly |
| `channel` | messages only, state unused |
| multiplayer game | state + messages, all clients, closes when it ends |

Sugar: `const ask = (c, d) => pi.view(c, d, { to: "originator", durable: true }).done;`

### Late join is the constraint

- A view component **must be reconstructible from `state` alone.** If it can only
  render correctly having seen the deltas, late join is broken. This is the rule
  plugin authors need told.
- `durable` means *survives process restart*, not *has state*.

|  | in memory | in snapshot | survives restart |
|---|---|---|---|
| `durable: false` | yes | yes | no |
| `durable: true` | yes | yes | yes |

- High-frequency traffic (60fps game state) goes over messages; the *board* goes in
  view state, so a late joiner sees the game. The plugin decides the split,
  explicitly.

### A view is a mini-session

Snapshot (`state`), deltas (changes), commands up (`on`). Reuses the sync
machinery. `SessionSnapshot` gets **one** section and the protocol **three** delta
types, permanently:

```ts
views: Array<{ viewId: string; component: string; state: unknown; to: string[] | "all" }>
```
```
view_state | view_message | view_closed
```

No plugin ever adds an event type.

### Durable views are steps

An effect whose settlement arrives from a client instead of a provider.
`harness.md` supplies the machinery: `replay: "safe"`, `effect_pending`,
deterministic ids off `${runId}:${toolCallId}`. On resume the view reopens with
the same id and the parked tool keeps waiting.

### Reconnect vs detach

- Reattach -> fresh snapshot, all views. Same path as late join.
- `durable: false` + last addressee leaves -> close with `no_clients`.
- `durable: true` + last addressee leaves -> stay open; the tool is still parked.

---

## 8. Core capabilities vs plugin services

**Core capabilities** are properties of `pi`. Statically typed, always present, no
resolution, no ordering, no "what if two plugins provide it." Swapped by whoever
constructs the harness, not by a plugin racing to `provide()`.

`fs`, `credentials`, `session`, `sessions`, `diagnostics`, `view`.

**Plugin services** are for the genuinely singleton, stateful, method-bearing
things one plugin owns and another calls. Typed token, exported by the provider,
imported by the consumer — because there is **no shared build**, so declaration
merging is unavailable.

```ts
// @pi/lsp/token.ts — contract only
export interface Lsp { definition(f: string, l: number, c: number): Promise<Loc[]>; }
export const lsp = defineService<Lsp>("@pi/lsp:lsp");

// provider
pi.provide(lsp, impl);

// consumer — the import IS the dependency
import { lsp } from "@pi/lsp/token";
const l = pi.use(lsp);        // throws naming both plugins if absent
const t = pi.tryUse(telemetry);
pi.onService(telemetry, (t) => { ... });
```

Rules: **one provider per token** (two is a collision, error at mount), many
consumers, many tokens per plugin. Ordering by manifest position, with a good
error rather than a lazy proxy.

Before adding a token, ask: *does more than one plugin contribute to it?* If yes
it is a registry, not a service. Most things that feel like services are registries
with a query on top — which is why the count keeps coming out at two or three.

**Start with zero services.** Put `fs` and `credentials` in core as constructor
arguments, the way `ModelRuntime` already takes a `CredentialStore`. Add the token
mechanism (~40 lines) only if someone actually needs to swap one from a plugin.

---

## 9. Storage

| | durable | synced | shape | naming |
|---|---|---|---|---|
| entries | yes | yes | append-only, tree-placed | settled |
| values | yes | yes | latest-wins at one bound typed address | settled |
| lists | yes | **no** (publish views) | append-only elements at one bound typed address | settled |
| tables | yes | **no** (publish views) | rows, queryable | **TBD** |
| settings | yes | yes | schema'd, layered | settled |
| presence | no | yes | per-attachment | TBD |
| view state | see 7 | yes | per-view | TBD |

- **`entryProjectors` returning `undefined`** makes an entry durable, ordered,
  tree-placed, and synced but **invisible to the model**. That is the mechanism
  for chat logs, audit trails, plugin history. Return messages instead and the
  agent sees it — one line's difference.
- **Values and lists are ordinary bound storage.** Plugins construct
  `value<T>(namespace, key?)` and `list<T>(namespace, key?)` addresses with a
  stable collision-resistant namespace. Namespace `pi` and `pi.*` are reserved
  for built-ins by contract. There is no plugin-specific state API, global type
  map, registry, or catalog.
- **Views publish client-facing state.** Do not turn values, lists, or the sync
  layer into a plugin event channel; project durable data into a view instead.
- **Tables are not auto-synced.** Publish a *view* of a table. The sync layer must
  not become a database replicator.
- **Settings** declared with a schema so clients render a settings UI without the
  plugin shipping one; layered defaults -> user -> project -> session; a change
  triggers a **rebuild**, not a reload.
- **Presence** is per-attachment, dies with the connection, must *not* survive
  restart.

Naming: plugins export ordinary typed address constants or constructors and use
those bound addresses for every later operation. The mount supplies or derives a
stable plugin namespace prefix; the storage API does not auto-register addresses
or add a `defineState` wrapper.

---

## 10. Slots

Fixed host-declared enum. Ids scoped to `(pluginId, localId)`, so collisions are
impossible. Additive by default, contained per-slot (a throwing footer widget
disappears; the footer survives). Genuinely exclusive surfaces get a user-visible
picker with a host fallback.

```ts
type SlotName = "footer" | "header" | "editor.above" | "editor.below"
              | "status" | "overlay" | "editor" /* exclusive */;
```

---

## 11. Module loading and reload

Verified on Node 22.22: **`await import("./ext.ts")` works with no flag, no jiti,
no build step.** `module.stripTypeScriptTypes` and `module.registerHooks` are both
available.

Three tiers by reload frequency:

| Case | Mechanism | Leak |
|---|---|---|
| Normal run — load once | `await import()`, native `.ts` | none |
| Dev reload — human editing | `registerHooks()` resolve hook appending `?gen=N` to specifiers under an extension root | bytecode per generation, bounded by patience |
| Agent-authored, long-lived daemon | worker per generation, or accept it | ~9.5MB/worker, full reclamation |

Measured: ~9.5MB RSS per worker; terminate reclaims most. Worker-per-extension is
dead; worker-per-generation is the only viable shape — and it is blocked on
providers carrying live methods on the streaming hot path.

**The reframing that matters:** opencode barely reloads modules at all. Settings
changes, config changes, and plugin toggles all go through `rebuild()` with the
module still cached. Only *source bytes changed* needs a second `import()`. Make
the common cases rebuilds and the leak becomes a few hundred KB a day.

### The single-file multi-tier hazard

Shared mutable module state between `session()` and `tui()` works in local mode and
breaks in remote mode. Two mitigations:

1. **Serializing in-process transport** in local mode — round-trip through the wire
   codec so unserializable payloads (class instances, `Map`, `Date`, functions)
   fail immediately. Keep this unconditionally.
2. **Static check at load** — if the module graph exports 2+ tier factories and
   contains top-level mutable bindings, refuse with a diagnostic naming the file
   and line. Zero runtime cost. Single-tier plugins exempt entirely.

Module-splitting per tier (`?runtime=session`) catches only the shallow case (child
imports are shared) and costs double evaluation at startup. Opt-in
`--strict-plugins` at most.

---

## 12. An app is a manifest

```jsonc
{
  "id": "coding-agent",
  "plugins": [
    "@pi/fs-local",
    "@pi/auth",
    "@pi/providers-builtin",
    "@pi/providers-catalog",
    "@pi/providers-models-json",     // last: user config wins
    "@pi/system-prompt",
    "@pi/skills",
    "@pi/tool-bash",
    "@pi/tool-read",
    "@pi/tool-edit",
    "@pi/tool-glob",
    "@pi/tool-grep",
    "@pi/tool-todo",
    "@pi/tool-task",
    { "id": "@pi/permissions", "config": { "mode": "ask" } },
    "@pi/commands-core",
    "@pi/tui-footer",
    "@pi/tui-header",
    "@pi/tui-themes",
    "@pi/tui-tool-renderers",
    "./my-extension"
  ]
}
```

`@pi/*` resolves through a built-in registry — internal modules, not published
packages. Third-party by npm or path. Same list, same API.

**Order is precedence**, visible and reorderable. A coding agent, a personal
assistant, and a Cowork-alike are three manifests over one core.

~24 plugins, 3 core capabilities. Compare DeepSeek's 200 packages and DI graph.

---

## 13. Worked example: the provider registry as plugins

Today's `ModelRuntime.rebuildProviders()` is already the pattern hand-rolled:
clear, replay every source, commit a snapshot. `recomposeProvider` is already
layered (`native ?? builtin` + models.json + extension). Failure isolation already
falls back to base. `validateExtensionProvider` already throws before mutating.

Two gaps: `extensionProviders` is `Map<id, ProviderConfigInput>` — **one extension
per provider**, hand-merged per field — and the layers are fixed slots rather than
an ordered list.

```ts
interface ProviderEntry {
  native?: Provider;               // opaque live Provider; replaces base
  layers: ProviderConfigInput[];   // ordered, merged at build
  overrides?: ModelOverrides;      // always last, regardless of position
}

interface ProviderDraft extends Draft<ProviderEntry> {
  native(id: string, p: Provider): void;
  layer(id: string, c: ProviderConfigInput): void;
  override(id: string, o: ModelOverrides): void;
  models(id: string, fn: (m: ModelSpec[]) => ModelSpec[]): void;
}
```

**`@pi/providers-builtin`** — pure data, static import:

```ts
pi.providers.add((d) => {
  for (const p of catalog.builtinProviders()) d.native(p.id, p);
});
```

**`@pi/providers-catalog`** — the I/O template:

```ts
let remote = new Map<string, ModelSpec[]>();

pi.providers.add((d) => {                     // sync, reads the variable
  for (const [id, models] of remote) if (d.has(id)) d.models(id, () => models);
});

pi.effect(async (signal) => {                 // the I/O
  remote = await loadCachedCatalog(pi.config.catalogPath);
  pi.providers.rebuild();                     // cache first — CLI usable in ~0ms
  if (!pi.config.offline) {
    remote = await fetchCatalog(pi.config.catalogBaseUrl, { signal });
    pi.providers.rebuild();                   // network second
  }
});
```

**`@pi/providers-models-json`** — user config, watched, hot-applies (today needs a
restart):

```ts
let config = ModelConfig.empty();

pi.providers.add((d) => {
  for (const [id, p] of config.providers()) {
    d.layer(id, p);
    if (p.modelOverrides) d.override(id, p.modelOverrides);
  }
});

pi.effect(async (signal) => {
  config = await ModelConfig.load(pi.config.modelsPath);
  pi.providers.rebuild();
  for await (const _ of watch(pi.config.modelsPath, { signal })) {
    try { config = await ModelConfig.load(pi.config.modelsPath); pi.providers.rebuild(); }
    catch (e) { pi.diagnostics.warn(`models.json: ${msg(e)}`); }   // keep last good
  }
});
```

**`@pi/auth`** — credentials are *not* a contribution. They do not change which
providers exist, only whether they are usable:

```ts
pi.effect(async (signal) => {
  await store.load();
  for await (const _ of watch(pi.config.authPath, { signal })) {
    await store.load();
    pi.providers.probe();          // re-probe availability, NOT rebuild
  }
});
```

**Availability is derived state, not a registry.** Async, network-touching,
sequence-coalesced — today's `runAvailabilityRefresh` unchanged:

```
providers.current()  -> every composed Provider          (build, sync)
availability.state   -> which are configured + auth type (probe, async)
models.available     -> derived: current() intersect configured
```

**Build** is the host's finalization — `composeModelProvider` keeps its job; its
signature loses `ModelConfig` (`(id, native, mergedLayers, overrides)`), which is
what lets models.json become a plugin at all.

Two decisions: `override()` stays a distinct always-last field (order cannot
express "after custom-model upserts, extension replacement, and OAuth
projection"); and rebuild must kick `availability.probe()` when it adds ids — an
explicit `onRebuild` in core rather than the fire-and-forget inside
`registerProvider`.

Also: `extensionProviders` is already an instance field, so pi-server.md's
"process-global provider registration must be removed" prerequisite looks
**already satisfied**. Worth confirming.

---

## 14. What harness.md gives for free

- **`missing_identities`** on restore names any tool whose plugin is not loaded,
  rather than silently dropping it. Better than anything the other four have.
- **Settings snapshotted at operation acceptance** — a rebuild mid-run cannot
  corrupt an in-flight generation.
- **Extension-owned bound values/lists** — durable per-run plugin state is
  explicit and keyed by lane/operation id. Hooks may replay before their
  consuming commit, so extensions own idempotency and cleanup.
- **Events passive by construction** — an observer cannot accidentally intercept.
- **`before_tool` fails closed** — a throwing plugin handler blocks that tool
  invocation instead of allowing an unreviewed effect to run.

---

## 15. Open questions

**Naming.** `table`, `kv`, `view` are placeholders. `view` is least-bad among
`surface`, `panel`, `handle`. Registry naming plural-vs-singular unsettled.

**Can `ask` address all clients?** Approve-from-any-device is real. If yes, pending
asks are snapshot state too and the ambient/blocking separation blurs. Lean:
allow `to: "all", settle: "first"` and accept it.

**Where do plugin custom entries land in the tree?** They need a parent, and a chat
message mid-run attaches to a leaf about to move. Two concurrent sends need a total
order. Possibly ambient plugin entries should not be tree-placed at all.

**Per-session vs per-connection registration.** `tui()` runs per attachment; two
clients on one session both register footer widgets. Probably: session rows
per-session, client rows and slot arbitration per-connection.

**Identity.** The chatroom case forces a minimal participant model. Durable entries
store a *snapshot* of the participant, not a reference.

**Cross-tier version skew.** `api: "1.0"` is per-extension, but a remote TUI client
and a session host may be different pi versions. Which governs? Consider eve's
build-time compatibility metadata.

**Permissions.** A plugin declaring what it needs (fs, network, spawn) so a manifest
is reviewable at install. bb does capability requests. Reserve the field.

**Diagnostics.** Every tier needs "what loaded, what failed, why."
`resources_changed` is this for the session tier; the others need one.

**Startup ordering.** `AgentHarness.create()` returns before effects start. What
happens in that window? Do plugins run before the first prompt is accepted?

**Cancellation.** Every entry point needs an `AbortSignal` — hooks, commands, view
message handlers, not just tool execute.

**Legacy extensions.** Unresolved. Local mode only, at best.

**Supervisor plugin tier is unbuilt.** Deliberately — the vertical slice excludes
session creation, deletion, and forking. Do not build it until a real automations or
session-list case demands it.

---

## 16. Still feels unresolved

The four verbs plus views plus storage is close but not yet *one thing*.

Concrete suspicion: **bound values, view state, and settings are three flavors
of one idea** — durable-ish, synced, snapshot-included, delta-emitting,
plugin-namespaced. They differ only in who writes and whether a component is
attached:

| | writer | rendered | layered |
|---|---|---|---|
| settings | user | by a settings UI | yes |
| bound values | plugin | no | no |
| view state | plugin | by a named component | no |

This does **not** imply another storage primitive: durable plugin data remains
ordinary bound values/lists. The open question is whether their client-facing
projections and settings can share one sync abstraction, leaving **synced
projections, ephemeral messages, durable rows, four verbs.** It might still be a
false economy that makes settings worse. Attack during the naming pass.
