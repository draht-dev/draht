# Changelog

## [Unreleased]

### Changed

- update the README's stale `claude-sonnet-4-20250514` and `gpt-4o` examples to `claude-sonnet-5` and `gpt-6.1-sol`
- update the stale `claude-sonnet-4-6` example in `examples/mcp-codemode/main.ts` to `claude-sonnet-5`

### Fixed

- pico docs (`docs/pico/pico-usage-v2.md`, `docs/pico/pico-usage-guide.md`) referenced the retired `gpt-5.6` id; switched to `gpt-6.1-sol`

## [2026.10.4-1] - 2026-10-04

### Added

- consolidate immutable delta tracking
- add hardened pico3 kernel
- add pico memory storage foundation
- refine pico core task capabilities
- add pico compile-time foundation
- stream legacy JSONL migration and forks
- fork closed legacy JSONL through format 4
- add two-pass JSONL fork prototype
- construct memory forks directly from live state
- centralize scalar fork namespace policy
- require explicit named branches for session forks
- clarify Chord remote service APIs
- simplify Chord service APIs
- simplify Chord service instance API
- make durable drive total
- make run boundaries atomic
- fuse structural boundary routing
- simplify durable operation graph
- clarify operation continuation semantics
- simplify durable drive runtime
- add durable tool execution
- add durable retry and deferred polling
- add explicit session mutations
- add durable generation procedures
- add durable terminal mechanics
- simplify durable drive ownership
- upgrade legacy v3 sessions on first write
- cover legacy v3 session forks
- resolve legacy v3 parent session metadata
- report usage for legacy v3 sessions
- remove manual drive controls
- replace remote sessions with routed services
- split legacy v3 normalization into focused phases
- import legacy v3 entry labels
- import legacy v3 session names
- rename breakpoint primitive
- simplify mutation event publication
- normalize legacy v3 configuration changes
- remove drive deadlines
- import legacy v3 JSONL compactions
- import legacy v3 JSONL branch summaries
- import legacy v3 JSONL custom messages
- import legacy v3 JSONL custom entries
- open legacy v3 JSONL message sessions
- implement atomic acceptance and coherent observation
- expose provider context construction
- thread context through execution capabilities
- discover legacy v3 JSONL sessions
- add invocation context primitives
- replace legacy harness runtime
- inspect restored runtime2 operations
- add runtime2 harness config
- add runtime2 lane creation
- centralize runtime2 lane commands
- finalize runtime2 lane transitions
- add runtime2 fault propagation
- add runtime2 close boundary
- add runtime2 lane configuration
- implement runtime2 harness facade
- add inert runtime2 shell
- serialize runtime2 lane transitions
- start lane-owned harness runtime
- organize AgentHarness runtime by protocol
- add AgentHarness R4 tool execution
- add AgentHarness R3 generation recovery
- add AgentHarness R2 minimal run
- add JSONL session forking
- add AgentHarness R1 runtime shell
- wire repo to return real session
- benchmark session repository lifecycle
- benchmark session repository forks
- share session benchmark infrastructure
- add session repository catalog benchmark
- isolate JSONL repository conformance tests
- isolate JSONL storage conformance tests
- add JSONL session repository lifecycle
- separate session ownership conformance
- split session repo conformance by capability
- simplify session repo conformance setup
- organize JSONL storage modules
- discard torn JSONL transaction tails
- add format-4 JSONL storage
- add harness execution primitives
- add guarded session mutations
- retain memory sessions across reopen
- add memory session repository
- add session lane creation
- add storage-backed session tree
- add storage-backed session boundary
- add session codec
- add instrumented storage decorator
- add storage backend conformance suite
- add session UUIDv7 generator
- add in-memory harness storage
- expose `expandPromptTemplates` in `sendUserMessage` (badlogic/pi-mono#7857)
- support clearing session names
- add direct harness event listeners
- add buffered harness event watches
- add harness events subscription interface
- allow blocked tool calls to terminate (badlogic/pi-mono#7715)
- add telemetry reference adapter and span composition
- harness v2 r2 (badlogic/pi-mono#7669)
- complete JSONL codec contract coverage
- split JSONL session backend modules
- add JSONL metadata contracts
- validate harness recovery record logs
- add indexed harness recovery queries (badlogic/pi-mono#7646)
- expose shouldStopAfterTurn on Agent (badlogic/pi-mono#7367)
- reject unsupported session search
- add storage-owned session readers
- add per-session store queues
- add harness shutdown lifecycle
- search index factory

### Changed

- changelog coverage for the v0.99.2 upstream sync
- feat(coding-agent): codemode and MCP
- feat(coding-agent): Virtual models (badlogic/pi-mono#10035)
- feat: build with TypeScript 7 and run sources with plain node
- feat(chord): make immutable delta tracker canonical
- feat: expose provider stream events to extensions (badlogic/pi-mono#9901)
- feat: add canonical session context boundaries
- feat: add transactional replicated state
- restore non-Pico5 documentation
- feat(durable): move Pico into dedicated package
- feat(agent): add Pico storage foundation
- docs(agent): finalize Pico5 specification set
- refine Pico5 plugin state API
- Mid conversation system messages (badlogic/pi-mono#9548)
- specify Pico5 harness API
- finalize Pico5 architecture and presentation
- docs(agent): replace obsolete Pico prototypes with Pico5 design
- pico3: forbid AsyncLocalStorage; nested-line detection via Chord context key
- pico3 review decisions: revision, visibility, memos, waiting, reload
- add pico3 view/events, plugins and hardening handoff
- correct pico v2 foundation contracts
- feat(agent): align pico foundation with v2 contract
- define pico v2 kernel contract
- simplify pico scheduling and core task model
- define pico state tasks and tool boundaries
- add approved pico implementation handoff
- require typed status payloads for pico task writes
- define pico system sections and mutable registries
- status lives in task state
- guide notes for appending entries
- turn tasks gate model-visible appends
- runtime schema bundle as a work item
- scope out permissions, migration and the wire schema
- note foreground dependencies on background work
- simplify input results and unify queued input
- tagged-union task state and derived orphaned variant
- pico handoff for outstanding decisions
- settle pico driver and storage contracts
- make pico input attribution explicit
- settle pico task lifecycle
- persist pico entry projections
- resolve pico context and state ordering
- add pico design drafts
- preserve pico2 spike design for review
- fix: cap agent retry backoff
- fix(coding-agent): update runtime dependencies (badlogic/pi-mono#9341)
- relax WP08 fork streaming requirements
- record JSONL fork capture question
- feat(ai): preserve Anthropic per-turn thinking effort
- fix: remove misleading write byte counts
- add scoped storage implementation handoff
- fix(agent): bound shell execution output
- close delta append API decision
- feat: add delta-backed replicated state
- align assistant output handoff with Chord
- add streaming fork work package
- add mobile design handoff
- align SQLite ownership with session workers
- feat: isolate Chord context API
- feat: consolidate Chord public API
- feat: move facet services into Chord
- feat: add Chord runtime foundation
- match upstream's plain stats in upgradeLegacyV3ToV4 commit
- add @vitest/coverage-v8 for the coverage:harness script
- feat(coding-agent): add facet-based slash commands
- feat(agent,coding-agent): unify process-local service lifecycle
- restore subtle harness contracts
- fix(agent): align facet service contracts and errors
- feat(agent): remove remote service events
- feat(coding-agent): derive facet service routing
- feat(coding-agent): replace facet attributes with services
- clarify harness alignment corrections
- condense harness specification
- audit post-WP05 roadmap
- feat(agent,ai): add narrow subpath exports so clients skip the barrel
- feat(agent): expose durable lane operations
- resolve M7 cancellation decisions
- redesign WP05 around lane inbox, result records, and neutral leaves
- feat(agent): add structural drive foundation
- fix(coding-agent): prevent Windows taskkill spawn crashes
- feat(agent): simplify durable runtime procedures
- feat(agent): separate sessions, branches, and lanes
- feat(coding-agent): add setup-driven facet generations
- restore direct tool batch procedure
- simplify durable drive ownership
- fix(agent): preserve legacy upgrade commit stats
- feat(agent): add durable drive foundations
- Use NoInfer<T>
- feat(agent): simplify plugin service names
- docs(agent): design plugin dependency discovery and reload
- remove stale legacy v3 TODO
- feat(agent): implement remote events and client TUI
- feat(coding-agent): scaffold built-in service surfaces
- feat(agent): add server-scoped session services
- repair direct drive handoff
- feat(agent): add routed plugin service runtime
- plan direct durable drive
- require clean-room drive implementation
- clarify deferred delta state design
- add collaborative canvas example motivating DeltaState
- preview manual-first drive
- align RPC design with plugin services
- explain why record mutations need a critical region
- add collaborative diff review example
- simplify durable interaction settlement
- model interactions as spawned services
- cover legacy v3 compaction tail projections
- cover invalid legacy v3 compaction boundaries
- cover legacy v3 compaction branch isolation
- cover legacy v3 compaction fromHook import
- simplify remote service state discovery
- revise distributed plugin design
- clarify fork snapshot memory expectations
- finalize repo and storage conformance
- simplify WP02 durability boundary
- feat(agent): add remote session RPC
- disambiguate plugin context type
- define coordinator plugin topology
- align WP02 contract with context baseline
- specify atomic attachment contract
- clarify invocation context motivation
- define coherent attachment work package
- clarify plugin hosts and service chaining
- document plugin application architecture
- update context design status
- feat(agent): thread invocation context through harness APIs
- align context design notes with implementation
- document invocation context RPC and telemetry design
- mark WP01 complete
- feat(agent): add bound values and lists
- update harness specification
- feat: stream remote session events to clients
- finalize bound values handoff
- clarify hook durability
- consolidate harness runtime plan
- docs(agent): track extension v2 design
- use typed register tokens
- specify register and tool durability
- document runtime2 close propagation
- clarify runtime2 close admission
- explain runtime2 close admission
- add slice-specific harness scratch examples
- keep storage register keys internal
- extract validateCommittedWrites as shared helper
- share session register key helper
- extract memory fork content selection
- document session fork options
- extract memory fork source validation
- run JSONL message conformance
- extract commit helpers
- share in-memory storage state
- feat(agent): add session storage benchmarks
- simplify harness execution architecture
- dont confuse clanker
- note on session stats
- feat(agent): add storage testing decorator
- remove obsolete session context type
- refactor(agent): trust typed session storage values
- update S3 to new search shape
- feat(ai): support UUIDv7 follower timestamps
- update search
- mark harness types slice complete
- feat(agent): establish durable harness type contracts
- add table of contents
- docs(agent): consolidate harness spec into harness.md
- restructure build order into parallel storage and runtime tracks
- make search a standalone service, open metadata-filter question
- specify optional pull-based search service
- add seq-ranged usage ledger scan
- one sqlite file per session, search becomes external
- replace historical rationale with direct statements
- drop historical changes appendix
- reword cancellation triage note
- tighten identity section
- re-mint legacy ids at import, drop redundant register paragraph
- clarify register references vs immutable snapshots
- drop historical placement-payload rationale
- resolve providers and tools at dispatch, drop lease machinery
- fix broken code fence in crash example
- search (badlogic/pi-mono#7797)
- introduce the three stores before the worked examples
- add transaction traces to orientation examples
- fix implementation-readiness review findings
- strip partitioning to informative section, finish audit fixes
- record open harness-v3 audit findings
- fix harness-v3 cold-read audit findings
- remove superseded harness design documents
- complete harness-v3 parts 8-9 and appendices
- write harness-v3 parts 6-7
- write harness-v3 parts 4-5
- write harness-v3 part 3
- write harness-v3 parts 0-2
- add harness-v3 skeleton merging spec and storage redesign
- add storage and retention redesign proposal
- clarify durable storage terminology
- add durable harness implementation spec
- complete explicit-state harness design
- clarify explicit operation records
- add explicit-state harness redesign
- docs(agent): tighten durable harness design
- docs(agent): reconcile durable harness design
- allow clearing session names
- add required fromHook to v4 summary entries
- remove legacy leaf entry requirements
- reserve I2
- restart checkpoint after auto-compaction
- add j6 typebox validation (badlogic/pi-mono#7768)
- clarify record query semantics
- clarify branch query start requirement
- clarify branch query helpers
- unreserve R3
- rebrand remaining pi-ai package reference in harness v2 design
- match harness telemetry diagram to emitted span names, rebrand stray package names
- reserve L1
- simplify harness work package workflow
- separate harness design from implementation status
- add missed JSONL matrix rows
- qa2 tests (badlogic/pi-mono#7706)
- reserve QA2
- update harness v2 md on how to use test matrix
- mark QA1 done
- harness v2 test matrix
- reserve QA1
- reserve harness v2 R3
- feat: extract telemetry package
- align telemetry design with implementation
- feat: add typed telemetry contracts
- docs(agent): finalize harness telemetry design
- mark JSONL J2 complete
- mark JSONL J1 complete
- f0 done
- scaffold test
- UnavailableRegistry
- reserve harness R2 work package
- clarify lane reduction contract (badlogic/pi-mono#7662)
- reserve harness I0 and L1-L3 work packages
- unreserve R2 work package
- reserve harness R1 work package
- reserve harness R0 work package
- chore: rename storage package to session-backends
- harness-v2: count forked messages in session stats
- clarify JSONL fork entry replay
- define harness implementation packages
- fix(agent): own SQLite backend tests in storage package (badlogic/pi-mono#7626)
- feat(agent): promote durable harness API
- refactor: update sqlite for lanes (badlogic/pi-mono#7591)
- remove superseded design docs
- make harness v2 telemetry self-contained
- fix coherence defects found by independent review
- fix(ai): separate deferred request options
- resolve open questions, add mechanical test constructions
- split harness experimental changes (badlogic/pi-mono#7587)
- feat(agent): implement harness v2 for in-memory storage (badlogic/pi-mono#7503)
- docs(agent): finalize harness v2 on the effects variant
- add durable queue-item cancellation to harness v2 variants
- split harness v2 into effects and generator variants
- feat(agent): compose session storage through repositories
- feat(agent): prepare session storage foundation for harness v2
- derive timeout output size from truncation limit
- fix(agent): harden bounded branch queries
- feat(agent): add bounded branch queries
- fix(agent): make timeout output test deterministic
- simplify session store guidance
- remove session API migration example
- fix(agent): clarify session persistence ownership
- refactor(client): tighten lifecycle state modeling
- feat(client): add runtime-neutral session client
- vars
- unify harness task tracking
- repo facade
- docs(agent): agent-loop building blocks in harness v2
- repo owns session and storage separately
- composable Storage vs Search
- search index swappable
- may not be index
- feat: search index sqlite

### Fixed

- use draht names for temp files and TUI logs
- require complete GIF image signatures
- relax fork lane validation and sequence conformance
- expand fork conformance for Memory and JSONL
- reject open legacy JSONL forks
- reduce JSONL fork list index memory
- map signal-killed processes to non-zero exit codes (badlogic/pi-mono#8994)
- retain settled tools until placement
- surface proxy stream EOF without terminal event as an error (badlogic/pi-mono#8997)
- finalize bounded shell output integration
- require configured lanes for branch forks
- validate fork entries against named branch ancestry
- stop prepared tools after preflight abort (badlogic/pi-mono#8936)
- align SQLite ownership with session workers
- finalize durable lane replication
- make durable assistant framing burst-safe
- make service hydration readiness explicit
- reject unsupported JSONL versions before replay
- extract JSONL storage serializer
- create JSONL sessions atomically
- cover atomic v3 upgrade publication failure
- cover zero-usage adjustment during v3 upgrade
- define rootless v3 label handling
- simplify legacy custom entry normalization
- decouple fork snapshots from storage state
- enforce JSONL session ownership
- dont load root mds as skills in settings (badlogic/pi-mono#8012)
- single edit input (badlogic/pi-mono#8011)
- tighten runtime2 harness boundaries
- normalize assistant request action name
- reserve JSONL session destinations
- narrow memory fork lane leaf registers type-safely
- make fork parent source-derived
- test session destination reservation order
- cover register rollback in storage conformance
- gate harness tool execution
- complete session acceptance coverage
- align context projection contract
- enforce durable assistant message handling
- enforce durable session identities
- simplify memory storage commit
- keep session implementations internal
- keep session codec internal
- deepen storage immutability conformance
- address harness type audit findings
- sqlite time to number
- no ctes in sqlite, delete indexes
- make JSONL decode errors explicit
- complete JSONL crash and corruption handling
- refactor jsonl codec
- populate session types with doc comments from design doc
- read JSONL headers when listing sessions
- reject conflicting JSONL session creation
- reject reset during active runs (badlogic/pi-mono#7717)
- simplify jsonl append failure test
- scope JSONL session IDs to working directories
- validate required JSONL mutation fields
- complete JSONL storage round-trip coverage
- require JSONL session cwd at creation
- project open operation id to lanes (badlogic/pi-mono#7654)
- stop JSONL repositories from retaining sessions
- match coding-agent JSONL session layout
- share state between memory and JSONL sessions
- list SQLite sessions without writer claims (badlogic/pi-mono#7655)
- correct JSONL fork entry semantics
- count copied messages in fork stats
- handle Windows resource paths
- repair tests after model refresh cancellation changes
- make SQLite session operations linear
- avoid counting entries when opening sessions
- rename session fork module
- make session search query-only
- scope JSONL entry IDs by path
- restore forward session cursor reads
- restrict session construction to repositories
- expose session stores through factories
- refine session repository API
- preserve waitForIdle semantics
- await mutations during harness shutdown
- do not require index
- helper owns create

## [2026.9.5-1] - 2026-09-05

### Changed

- biome formatting for the signal exit-code ports
- fix(agent): map signal-killed processes to non-zero exit codes (#8994)
- fix(agent): surface proxy stream EOF without terminal event as an error (#8997)
- fix(agent): stop prepared tools after preflight abort (#8936)
- fix(coding-agent): prevent Windows taskkill spawn crashes
- fix: single edit input (#8011)
- feat(agent): allow blocked tool calls to terminate (#7715)
- fix(agent): reject reset during active runs (#7717)

### Fixed

- stop the bash timeout-truncation test racing its own output

## [2026.7.30] - 2026-07-30

### Added

- incorporate upstream agent package changes

### Changed

- docs(agent): harness design v2 (harness-v2.md)
- fix(ai): update TypeBox nullable array validation (#7243)
- rebrand pi references in newly synced docs
- add refs to harness design
- durable AgentHarness design (harness.md)
- feat(ai): expose pending stop reason while streaming (#7151)
- fix(agent,ai): don't cache write compaction or branch summaries (#6618)
- feat(agent): align harness execution tools
- fix(agent): restore streamFn extension compatibility
- feat(agent): add AgentHarness execution tools
- feat: sqlite session storage (#6594)
- drop orphaned duplicate session storage/repo tree
- fix(agent): decouple agent streams from compat
- fix: complete extension usage accounting
- feat(ai): add shared contentText utility (#6840)
- fix(ai,agent,coding-agent): share UUIDv7 and use for Codex (#6834)

### Fixed

- post-sync review fixes for pi v0.80.10 incorporation

## [2026.7.12] - 2026-07-12

### Changed

- migrate workspace checks to TypeScript 7

## [2026.7.11] - 2026-07-11

### Added

- incorporate upstream agent package changes

## [2026.7.7] - 2026-07-06

### Added

- incorporate upstream agent package changes
- incorporate upstream agent package changes

## [2026.6.11] - 2026-06-11

### Added

- incorporate upstream agent package changes
- incorporate upstream agent package changes

### Changed

- update documentation from upstream

### Fixed

- restore supportsMax and max thinking level, harden branding guard

## [2026.4.25] - 2026-04-25

### Added

- add "max" to ThinkingLevel type

### Changed

- bump workspace version to 2026.4.25

## [2026.4.23] - 2026-04-23

### Added

- add prepareArguments hook for pre-validation argument preparation

### Changed

- rebrand and fix after upstream sync
- update steering docs for deferred tool execution closes #2330

### Fixed

- await subscribed event handlers
- simplify state API and update consumers fixes #2633
- expose abort signal to extensions closes #2660
- defer steering until after tool execution
- remove broken async loop test

## [2026.4.5] - 2026-04-05

### Changed

- update steering docs for deferred tool execution closes #2330
- clarify non-throwing stream and hook contracts
- clarify non-throwing stream contracts fixes #2119

### Fixed

- preserve tool result order in parallel execution and handle stream rejections
- resolve upstream sync conflicts and fix branding
- defer steering until after tool execution
- remove broken async loop test

## [2026.3.11] - 2026-03-11

### Fixed

- add missing @sinclair/typebox devDependency

## [2026.3.5] - 2026-03-05

### Changed

- update author field across all packages

## [2026.3.4] - 2026-03-04

### Added

- rebrand to @draht/ namespace

### Changed

- update repo URLs from draht-dev/draht to draht-dev/draht
- rebrand all READMEs to draht naming and conventions
- add publishConfig for public npm access
- switch from npm to bun, replace tsx with bun runtime, add tsgo

### Fixed

- align package versions to daily versioning and use workspace:* for internal deps
- address code review findings and fix router stream types

## [2026.3.2-9] - 2026-03-02

### Changed

- update repo URLs from draht-dev/draht to draht-dev/draht

## [2026.3.2-8] - 2026-03-02

### Changed

- rebrand all READMEs to draht naming and conventions

## [2026.3.2-4] - 2026-03-02

### Added

- rebrand to @draht/ namespace

## [0.55.3] - 2026-02-27

- add publishConfig for public npm access
- switch from npm to bun, replace tsx with bun runtime, add tsgo

### Fixed

- use workspace:* for all inter-package dependencies
- address code review findings and fix router stream types

## [0.52.12] - 2026-02-13

### Added

- Added `transport` to `AgentOptions` and `AgentLoopConfig` forwarding, allowing stream transport preference (`"sse"`, `"websocket"`, `"auto"`) to flow into provider calls.

## [0.52.7] - 2026-02-06

### Fixed

- Fixed `continue()` to resume queued steering/follow-up messages when context currently ends in an assistant message, and preserved one-at-a-time steering ordering during assistant-tail resumes ([#1312](https://github.com/draht-dev/draht/pull/1312) by [@ferologics](https://github.com/ferologics))

## [0.50.8] - 2026-02-01

### Added

- Added `maxRetryDelayMs` option to `AgentOptions` to cap server-requested retry delays. Passed through to the underlying stream function. ([#1123](https://github.com/draht-dev/draht/issues/1123))

## [0.38.0] - 2026-01-08

### Added

- `thinkingBudgets` option on `Agent` and `AgentOptions` to customize token budgets per thinking level ([#529](https://github.com/draht-dev/draht/pull/529) by [@melihmucuk](https://github.com/melihmucuk))

## [0.37.3] - 2026-01-06

### Added

- `sessionId` option on `Agent` to forward session identifiers to LLM providers for session-based caching.

## [0.37.0] - 2026-01-05

### Fixed

- `minimal` thinking level now maps to `minimal` reasoning effort instead of being treated as `low`.

## [0.32.0] - 2026-01-03

### Breaking Changes

- **Queue API replaced with steer/followUp**: The `queueMessage()` method has been split into two methods with different delivery semantics ([#403](https://github.com/draht-dev/draht/issues/403)):
  - `steer(msg)`: Interrupts the agent mid-run. Delivered after current tool execution, skips remaining tools.
  - `followUp(msg)`: Waits until the agent finishes. Delivered only when there are no more tool calls or steering messages.
- **Queue mode renamed**: `queueMode` option renamed to `steeringMode`. Added new `followUpMode` option. Both control whether messages are delivered one-at-a-time or all at once.
- **AgentLoopConfig callbacks renamed**: `getQueuedMessages` split into `getSteeringMessages` and `getFollowUpMessages`.
- **Agent methods renamed**:
  - `queueMessage()` → `steer()` and `followUp()`
  - `clearMessageQueue()` → `clearSteeringQueue()`, `clearFollowUpQueue()`, `clearAllQueues()`
  - `setQueueMode()`/`getQueueMode()` → `setSteeringMode()`/`getSteeringMode()` and `setFollowUpMode()`/`getFollowUpMode()`

### Fixed

- `prompt()` and `continue()` now throw if called while the agent is already streaming, preventing race conditions and corrupted state. Use `steer()` or `followUp()` to queue messages during streaming, or `await` the previous call.

## [0.31.0] - 2026-01-02

### Breaking Changes

- **Transport abstraction removed**: `ProviderTransport`, `AppTransport`, and `AgentTransport` interface have been removed. Use the `streamFn` option directly for custom streaming implementations.

- **Agent options renamed**:
  - `transport` → removed (use `streamFn` instead)
  - `messageTransformer` → `convertToLlm`
  - `preprocessor` → `transformContext`

- **`AppMessage` renamed to `AgentMessage`**: All references to `AppMessage` have been renamed to `AgentMessage` for consistency.

- **`CustomMessages` renamed to `CustomAgentMessages`**: The declaration merging interface has been renamed.

- **`UserMessageWithAttachments` and `Attachment` types removed**: Attachment handling is now the responsibility of the `convertToLlm` function.

- **Agent loop moved from `@draht/ai`**: The `agentLoop`, `agentLoopContinue`, and related types have moved to this package. Import from `@draht/agent-core` instead.

### Added

- `streamFn` option on `Agent` for custom stream implementations. Default uses `streamSimple` from @draht/ai.

- `streamProxy()` utility function for browser apps that need to proxy LLM calls through a backend server. Replaces the removed `AppTransport`.

- `getApiKey` option for dynamic API key resolution (useful for expiring OAuth tokens like GitHub Copilot).

- `agentLoop()` and `agentLoopContinue()` low-level functions for running the agent loop without the `Agent` class wrapper.

- New exported types: `AgentLoopConfig`, `AgentContext`, `AgentTool`, `AgentToolResult`, `AgentToolUpdateCallback`, `StreamFn`.

### Changed

- `Agent` constructor now has all options optional (empty options use defaults).

- `queueMessage()` is now synchronous (no longer returns a Promise).
