# Plugin Reloading

> **Status:** Design input for the plugin architecture in `plugins.md`. This document defines the architectural reload model, not an implementation handoff. Exact control messages, persisted file formats, retry timing, and diagnostics remain implementation details.

Read `plugins.md` for host facets and service contracts, `rpc.md` for binding and subscription semantics, and `harness.md` for the durable Session and execution model. This document and `plugins.md` supersede the service-dependency, reload, and rollback discussion in the exploratory `extensions/pi-extensions-v2.md` where they conflict.

## Decision

A source reload replaces one complete application manifest generation across every host facet. It does not replace one service implementation, one registration, or one facet independently.

One reload targets:

- the server facet set in the server host;
- the session facet set in every live session worker;
- the presentation facet set in every connected TUI or web host; and
- the same facet set for hosts started after the reload.

The hosts do not switch at one atomic instant. The server records one desired manifest generation and every host converges on it. A session worker or presentation may temporarily run a different generation while it stops, restarts, reconnects, or fails. Plugin contracts must remain forward compatible across this window.

Reload uses ordinary host shutdown and startup. It has no stronger safety guarantee, no rollback guarantee, and no test that arbitrary in-process work is safe to restart.

## Terms

These operations are different:

- **Rebuild** replays active contributions over a fresh draft and commits a new registry value. Settings, configuration, availability, or source data changed, but plugin module bytes did not.
- **Reload** selects a new manifest generation after plugin source or the selected plugin set changed. Every facet is replaced.
- **Restart** stops and recreates a concrete server, session worker, or presentation runtime while implementing a reload.
- **Rebind** moves a remote service namespace from one live provider binding to another and hydrates fresh snapshots.
- **Resume** continues durable Harness work from the Session repository after a worker restart.

Most runtime changes should be rebuilds. Only changed source bytes, changed plugin resolution, or changed manifest membership require reload.

## Durability boundary

Pi has a stronger durability boundary than an in-process plugin framework. The authoritative Session, accepted operations, invocation memos, plugin-owned bound values and lists, and other committed Session records survive the process that currently projects them.

A reload divides state into three layers:

1. **Durable authority** survives reload. It includes Session records, durable Harness control, accepted operation IDs, plugin-owned durable records, and persisted server intentions.
2. **Host runtime state** is reconstructed. It includes Harness instances, extension runners, service providers, contribution drafts, listeners, timers, caches, open files, and subprocess handles.
3. **Presentation replicas** are rebound. They include `ReplicatedState` values, event listeners, keyed observer tasks, widgets, and attachment routes.

Reload never reverses committed durable state. Cordis-style inverse tracking is useful for orderly release of process-local resources, but it is not a transaction over Session history, filesystem emissions, subprocess effects, or network effects. A plugin that needs durable recovery must express it through the Session durability model rather than rely on a disposer.

A removed plugin's durable state is retained under its stable plugin namespace. Removal stops its code and projections; it does not erase its records. The plugin may return in a later manifest generation.

Durable schemas and resumable behavior are the plugin's compatibility responsibility. An operation accepted under generation N may resume under generation N+1. Reload introduces no new migration or version-pinning mechanism beyond that existing durability requirement.

## User-visible operation

For now, reload is explicitly initiated by the user through `/reload`, as in the current coding agent. The command belongs to host control, outside the plugin runtime being replaced.

The command completes when the system has accepted the reload and begun moving to the new desired generation. It does not wait for every host to become usable again. Normal application interaction may suspend while the Harness, services, and presentation are unavailable, but that suspension is host behavior rather than the lifetime of the command invocation.

A reload cannot be cancelled. A later implementation may report progress for each host, but cancellation would create another partially coordinated generation and is not part of the model.

`/reload` must not be implemented as a session plugin service method. Otherwise the retiring service namespace would be asked to destroy itself while its own invocation remained active. A minimal reload and failure-reporting path must remain available even when plugin facets fail to load.

## Manifest generations

The server owns the desired manifest generation. The server directory contains the persistent server state needed to recover after server replacement, including:

- the desired manifest generation and resolved plugin identity;
- the sessions whose workers the server intends to keep connected or reconstruct; and
- reload failure information needed to explain a degraded host after restart.

The exact file layout is not part of this design. Transient request IDs, subscription IDs, attachment IDs, and process IDs are not durable plugin state.

One generation names one resolved manifest across all facet kinds. Hosts resolve only their own entry points, but they report and converge on the same generation. A newly opened session starts directly on the desired generation. A live host leaves its previous generation by ordinary shutdown and then starts the desired one.

Temporary cross-generation communication is expected. The system does not attempt a distributed lock-step commit. Shared service contracts, durable records, and control messages must tolerate the supported forward-compatibility window. Runtime member-kind validation remains useful but does not replace contract compatibility.

## Dependency discovery and manifest validation

The service dependency graph is generated from facet setup, not reflected from erased TypeScript interfaces and not maintained as a parallel handwritten list. Every service token retains a stable runtime ID. Each host constructs facet contexts whose methods close over the host-assigned plugin ID and facet kind, so ownership remains correct even when setup functions run concurrently.

During setup the host records:

```text
provide(service, implementation)  → this facet provides service/singleton
provideKeyed(service)             → this facet provides service/keyed
use(service)                      → this facet requires service/singleton
observe(service, handler)         → this facet requires service/keyed
```

The context path supplies the target scope: local `use()`, `server.use()`, and `session.use()` are different requirements. The token supplies the service ID, and the operation supplies singleton or keyed mode. No runtime representation of the generic service interface is needed.

First acquisition and provision are setup-only operations. Commands, hooks, event handlers, and activation callbacks use handles acquired during setup. `provideKeyed()` returns the only handle permitted to spawn that service's dynamic instances, allowing the provision to appear in the graph before any instance exists.

After setup, each host emits a JSON-safe facet plan:

```ts
interface ServiceKey {
	scope: "local" | "server" | "session";
	serviceId: string;
	mode: "singleton" | "keyed";
}

interface FacetServicePlan {
	pluginId: string;
	facet: "server" | "session" | "tui" | "web";
	requires: ServiceKey[];
	provides: ServiceKey[];
}
```

Host control combines plans by scope, service ID, and mode. It rejects missing providers, duplicate singleton providers, mode mismatches, and invalid dependency cycles; derives service allowlists; and records provider-to-consumer edges for diagnostics and lifecycle ordering. `use()` and `observe()` are hard requirements; optional dependencies need a separate explicit acquisition operation if introduced later. Directly importing another plugin's live implementation bypasses this ownership model and is unsupported.

Removing one plugin constructs a candidate manifest without that plugin and runs the same assembly. If retained facets have unresolved hard requirements, the candidate is rejected before becoming the desired generation. If it is valid, removal still uses a complete-generation reload and simply brings back fewer facets. The removed plugin's durable namespace remains stored.

The service graph does not replace the module loader's source import graph. Partial source invalidation would need both graphs: one for runtime service dependents and one for modules importing changed bytes. Complete-generation reload deliberately avoids that additional mechanism. A future partial unload would also require per-plugin scopes, per-service withdrawal and rebinding, local stale-reference fencing, and dependent deactivation ordering; the graph is necessary for that design but does not by itself provide it.

## Reload sequence

At the architectural level, a reload proceeds as follows:

```text
user invokes /reload
→ server records desired manifest generation N+1
→ application enters reloading presentation state
→ every live host stops its complete generation-N facet set
→ server/session/presentation runtimes restart on N+1
→ connections and Session attachments are re-established
→ remote namespaces hydrate fresh snapshots
→ normal application interaction resumes where required hosts are ready
```

Module resolution and syntax may be checked before tearing down the old generation. Such preflight reduces avoidable failures but does not make reload transactional. Module evaluation may itself be defective, facet setup may fail only with host capabilities, and startup may fail after the old runtime has stopped.

All facet-owned resources close through the ordinary lifecycle scope before graceful process exit. If graceful shutdown fails, the host may terminate the process according to its normal shutdown policy. The operating system then reclaims process resources, but it cannot undo external emissions or make an unsafe tool restartable.

## Session-worker replacement

Exactly one process owns an open Session and Harness at a time. The Session repository and the worker lock enforce that rule. Session reload therefore is a handoff, not blue/green activation:

```text
old worker stops accepting work
→ ordinary Harness/worker shutdown runs
→ old worker releases Session ownership
→ replacement worker opens the same Session
→ replacement constructs the Harness and complete service provider
→ presentations receive fresh routes and snapshots
```

There is intentionally an interval with no authoritative worker. The server retains the logical fact that a presentation selected a Session even while no live route exists.

Reload does not wait for a special reload-safe Harness state. It behaves like stopping and restarting the Harness. Durable state provides valid reconstruction where the Harness and plugin contracts support it. Process-local or externally executing effects may fail:

- a running shell command is not generally restartable;
- a tool may not have a safe replay path;
- a provider request may be interrupted;
- a plugin-owned subprocess may be terminated; and
- an invocation may have committed durable state while losing its response.

These are ordinary shutdown hazards. Reload does not claim to repair them. Tools and plugins that support durable resumption must use the existing Harness mechanisms; those that do not may fail when the user reloads at an unsafe time.

## Calls during replacement

Reload adds no RPC transaction or automatic replay.

When a host begins shutdown:

- it stops accepting new work through the retiring binding;
- active invocation contexts, watches, subscriptions, and observations close through normal shutdown;
- interrupted calls fail with cancellation, disconnect, reloading, or unavailable behavior appropriate to the boundary;
- calls are never queued merely because a replacement is starting; and
- clients never blindly replay a mutation whose outcome is uncertain.

A call may have committed durable state before its response was lost. The caller must reconnect, hydrate authoritative state, and reconcile through a stable operation ID or an idempotent application method where the contract provides one. This is the same rule as an uncertain transport disconnect.

Service-owned work remains distinct from an invocation. If it is durable, the replacement reconstructs it from durable records. If it is process-local, ordinary shutdown may abort it. Closing an RPC wait must not silently write durable cancellation.

## Attachment replacement

A presentation's logical Session selection and its live route are separate state:

```text
selected Session S + live attachment A
selected Session S + no live route while reloading
selected Session S + replacement attachment B
```

A replacement worker receives fresh attachment IDs. Attachment IDs are transport-internal, so preserving one across worker generations has no plugin-level benefit. Fresh IDs reuse the existing stale-route fence: delayed calls and frames for A cannot address B.

`SessionServices.attachment` continues to use the existing presentation-safe states:

```ts
type AttachmentState =
	| { status: "detached" }
	| { status: "attaching" | "attached" | "degraded"; sessionId: string };
```

During replacement the selected Session is `attaching`. Successful route acquisition moves it to `attached`; replacement failure moves it to `degraded`. `detached` remains an intentional absence of selection, not a synonym for worker restart.

The global suspended reload experience is separate from attachment state. Attachment state reports only whether the selected Session is currently routable.

## Service lifetime

A remote service implementation belongs to its providing host generation. Services are not independently hot-swapped in the initial design.

This matches the basic implementation:

- `RemoteServiceProvider.provide()` installs one singleton for the provider's lifetime;
- plugin-facing `provideKeyed()` registers keyed ownership during setup, while its scoped handle delegates dynamic instances to provider `spawn()` and preserves generation fencing when a key is reused;
- disposing a provider removes its member listeners and subscriptions;
- a server connection or Session attachment change makes `RemoteServiceNamespace` close old subscriptions and hydrate new ones; and
- binding revisions and attachment IDs fence delayed frames.

There is therefore no need for a singleton-provider replacement frame or public singleton generation merely to reload plugins. Replacing the server connection or Session attachment replaces the provider binding as a whole. A stable remote facade may remain a local object, but it becomes unready and receives a complete snapshot from the replacement before it is usable again.

Changing the manifest may add or remove service tokens. Provider and consumer allowlists are loaded from their respective facets in the new manifest generation. During temporary version skew, a service absent from one side fails normally; forward-compatible plugin bundles must not assume every host has switched already.

Local service implementations are replaced with their host generation as well. Captured local implementation objects from the retired generation are stale and must not be retained by host-global state.

## Current core services

The experimental core services already illustrate the reconstruction rules:

| Service | Current owner | Reconstruction after reload |
|---|---|---|
| `SessionDirectory` | Server, with one provider per presentation over shared repository-backed state | List the repository again and publish a complete directory snapshot. Directory events during the gap are not replayed. |
| `SessionManagement` | Server provider closure bound to one presentation | Recreate the per-presentation implementation after reconnect. In-flight management calls follow ordinary uncertain-disconnect semantics. |
| `Models` | Session worker over Harness and `ModelRuntime` | Read selected model and thinking level from the Harness and rebuild the catalog from the model runtime. Process-local refresh status is discarded. |
| `Chat` | Session worker over the Harness | Durable accepted work remains in the Session. A call interrupted before receiving its operation ID has an uncertain outcome and must not be blindly retried. |
| `Accounts` | Session worker facade over credential authority | Rebuild presentation-safe account summaries from the credential source. Credentials never live in `ReplicatedState`. |
| `Transcript` | Session worker projection of durable lane state | Hydrate an authoritative revisioned snapshot, then resume semantic event delivery. Snapshot/event gap handling is required before removing the compatibility watch. |

`Accounts` and `Transcript` are currently incomplete scaffolds, but their reload ownership follows the same rule.

Provider-local counters are not automatically durable. `ReplicatedState` transport sequences, keyed generations, model-catalog revisions, and directory revisions may restart with a new provider binding unless their application contract explicitly makes them durable. Consumers must not compare binding-scoped revisions across a rebind as if they were globally monotonic.

## Replicated state and events

`ReplicatedState` is a projection, not storage. Every state needed after reload must be reconstructible from durable authority, configuration, or another owned source. On provider replacement, the consumer becomes unready and installs a fresh complete snapshot before later updates.

`RemoteEvents` is non-durable and non-replayed. Events emitted while no subscription is active are lost. A consumer that must recover after reload needs one of:

- a `ReplicatedState` snapshot;
- a pull method returning current authority; or
- an application-level revisioned snapshot/event protocol such as `Transcript`.

Keyed services are live projections. If an instance must return after worker replacement, its owner reconstructs it from durable invocation or plugin records. The new provider may reuse the logical key, but it creates a fresh live generation under the new attachment binding. A stale proxy never locates durable work by key alone.

## Contribution registries

Contribution registries are rebuilt, not individually undone. The new host generation collects the complete ordered contribution set, replays it over fresh drafts, finalizes each registry, and publishes the resulting state.

This is preferable to asking plugins to reverse mutations to a shared tool, provider, command, or renderer registry. Lifecycle disposal still closes process-local effects, but registry correctness comes from reconstruction.

A configuration or settings change that leaves module bytes and manifest membership unchanged should rebuild the affected registries in the current generation rather than trigger `/reload`.

## Failure semantics

Reload has no runtime rollback guarantee.

If generation N stops and N+1 fails, the affected host remains unavailable or degraded. The system records and reports the failure. It does not silently restore N. The user fixes the plugin or configuration and invokes reload or restart again.

Durable records remain as committed. Plugin state remains retained. Other sessions or hosts that already reached N+1 remain there; the desired generation does not move backward merely because one host failed.

The following claims are explicitly out of scope:

- atomic reload across processes;
- safe reload detection;
- rollback of durable writes or external effects;
- preservation of arbitrary plugin-local memory;
- transparent replay of interrupted RPC methods;
- per-service hot module replacement; and
- automatic durable schema migration.

## Relationship to Cordis

Cordis identifies two useful concerns: resources created by a component need lifecycle ownership, and consumers must respond when a provider disappears. Pi keeps both principles:

- facet scopes own registrations, listeners, subscriptions, and process-local effects; and
- remote namespace bindings become unavailable and rehydrate against replacement providers.

Pi does not adopt Cordis's in-process component reload as its primary mechanism. Durable Session authority, process-per-session isolation, server replacement, and snapshot-based service rebinding make host-generation replacement the simpler boundary. Inverse disposal remains cleanup, not rollback.

This also follows Cordis's system-boundary caveat: acquiring and releasing a process resource may be reversible, while bytes already written, commands already executed, and durable records already committed are not.

## Architectural footguns

- Implementing `/reload` inside the plugin or service runtime it destroys.
- Loading only one facet of a multi-facet plugin on new source bytes.
- Opening the same Session in old and replacement workers concurrently.
- Treating `ReplicatedState` as the durable source rather than a reconstructible projection.
- Depending on `RemoteEvents` to repair missed state after restart.
- Reusing an attachment ID across worker generations and weakening stale-route fencing.
- Automatically retrying a call after reload when its durable outcome is uncertain.
- Deleting namespaced durable data when a plugin leaves the manifest.
- Treating provider-local sequence or revision values as global across bindings.
- Retaining implementation objects, callbacks, or contexts from a retired generation in host-global state.
- Performing uncontrolled top-level module side effects before the host owns a lifecycle scope.
- Acquiring a service for the first time from a later command or callback, after dependency assembly has closed.
- Dynamically spawning a keyed service without first registering its owner through `provideKeyed()`.
- Importing another plugin's live implementation instead of depending on a host-mediated service.
- Describing preflight checks as an atomic or rollback-capable reload.

## Required tests

A later implementation handoff should cover at least:

- one `/reload` selects one new manifest generation for server, session, and presentation facets;
- setup-time service acquisition produces complete cross-facet requirement and provision plans without reflecting on TypeScript types;
- missing providers, duplicate singleton providers, mode mismatches, and late dependency acquisition are rejected;
- removing a plugin rejects an invalid dependent manifest or performs a complete reload with fewer facets while retaining its durable state;
- configuration-only changes rebuild without loading a new module generation;
- a worker releases Session ownership before its replacement opens the Session;
- reload during active non-restartable work follows ordinary shutdown behavior and makes no false recovery guarantee;
- interrupted calls are not automatically replayed;
- a committed durable operation remains discoverable after its initiating response is lost;
- logical Session selection survives the route gap, reports `attaching` or `degraded`, and receives a fresh attachment ID on success;
- old attachment calls, service updates, and keyed proxies are rejected after replacement;
- singleton state rehydrates from a complete new snapshot before updates and events flow;
- non-durable events are not replayed, while snapshot-backed services recover current state;
- durable keyed interactions reconstruct from records with fresh live generations;
- removed plugin data remains stored and is readable when the plugin returns;
- server replacement reads desired manifest and worker intentions from the server directory;
- a failed replacement remains degraded and reports diagnostics without rolling back; and
- temporary old/new facet skew exercises forward-compatible contracts rather than assuming lock-step rollout.
