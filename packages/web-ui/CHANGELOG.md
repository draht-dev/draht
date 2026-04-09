# Changelog

## [Unreleased]

## [2026.4.5] - 2026-04-05

### Added

- export CustomProviderDialog closes #2267

### Changed

- refactor(coding-agent): add runtime host for session switching closes #2024

### Fixed

- align README architecture diagram closes #2425
- update thinking selector immediately closes #2306
- add model selector filter, onModelSelect callback, onClose callback, fuzzy search, fix streaming duplicates
- build with tsc instead of tsgo

## [2026.3.11] - 2026-03-11

### Fixed

- add missing dependencies for CI build
- add missing @draht/agent-core, @sinclair/typebox, and highlight.js dependencies

## [2026.3.5] - 2026-03-05

### Changed

- update author field across all packages

## [2026.3.4] - 2026-03-04

### Added

- rebrand to @draht/ namespace

### Changed

- rebrand all READMEs to draht naming and conventions
- switch from npm to bun, replace tsx with bun runtime, add tsgo

### Fixed

- align package versions to daily versioning and use workspace:* for internal deps
- address code review findings and fix router stream types

## [2026.3.2-8] - 2026-03-02

### Changed

- rebrand all READMEs to draht naming and conventions

## [2026.3.2-4] - 2026-03-02

### Added

- rebrand to @draht/ namespace

## [0.55.3] - 2026-02-27

- switch from npm to bun, replace tsx with bun runtime, add tsgo

### Fixed

- use workspace:* for all inter-package dependencies
- address code review findings and fix router stream types

## [0.52.10] - 2026-02-12

### Fixed

- Made model selector search case-insensitive by normalizing query tokens, fixing auto-capitalized mobile input filtering ([#1443](https://github.com/draht-dev/draht/issues/1443))

## [0.50.2] - 2026-01-29

### Added

- Exported `CustomProviderCard`, `ProviderKeyInput`, `AbortedMessage`, and `ToolMessageDebugView` components for custom UIs ([#1015](https://github.com/draht-dev/draht/issues/1015))

## [0.49.3] - 2026-01-22

### Changed

- Updated tsgo to 7.0.0-dev.20260120.1 for decorator support ([#873](https://github.com/draht-dev/draht/issues/873))

## [0.31.0] - 2026-01-02

### Breaking Changes

- **Agent class moved to `@draht/agent-core`**: The `Agent` class, `AgentState`, and related types are no longer exported from this package. Import them from `@draht/agent-core` instead.

- **Transport abstraction removed**: `ProviderTransport`, `AppTransport`, `AgentTransport` interface, and related types have been removed. The `Agent` class now uses `streamFn` for custom streaming.

- **`AppMessage` renamed to `AgentMessage`**: Now imported from `@draht/agent-core`. Custom message types use declaration merging on `CustomAgentMessages` interface.

- **`UserMessageWithAttachments` is now a custom message type**: Has `role: "user-with-attachments"` instead of `role: "user"`. Use `isUserMessageWithAttachments()` type guard.

- **`CustomMessages` interface removed**: Use declaration merging on `CustomAgentMessages` from `@draht/agent-core` instead.

- **`agent.appendMessage()` removed**: Use `agent.queueMessage()` instead.

- **Agent event types changed**: `AgentInterface` now handles new event types from `@draht/agent-core`: `message_start`, `message_end`, `message_update`, `turn_start`, `turn_end`, `agent_start`, `agent_end`.

### Added

- **`defaultConvertToLlm`**: Default message transformer that handles `UserMessageWithAttachments` and `ArtifactMessage`. Apps can extend this for custom message types.

- **`convertAttachments`**: Utility to convert `Attachment[]` to LLM content blocks (images and extracted document text).

- **`isUserMessageWithAttachments` / `isArtifactMessage`**: Type guard functions for custom message types.

- **`createStreamFn`**: Creates a stream function with CORS proxy support. Reads proxy settings on each call for dynamic configuration.

- **Default `streamFn` and `getApiKey`**: `AgentInterface` now sets sensible defaults if not provided:
  - `streamFn`: Uses `createStreamFn` with proxy settings from storage
  - `getApiKey`: Reads from `providerKeys` storage

- **Proxy utilities exported**: `applyProxyIfNeeded`, `shouldUseProxyForProvider`, `isCorsError`, `createStreamFn`

### Removed

- `Agent` class (moved to `@draht/agent-core`)
- `ProviderTransport` class
- `AppTransport` class
- `AgentTransport` interface
- `AgentRunConfig` type
- `ProxyAssistantMessageEvent` type
- `test-sessions.ts` example file

### Migration Guide

**Before (0.30.x):**
```typescript
import { Agent, ProviderTransport, type AppMessage } from '@draht/web-ui';

const agent = new Agent({
  transport: new ProviderTransport(),
  messageTransformer: (messages: AppMessage[]) => messages.filter(...)
});
```

**After:**
```typescript
import { Agent, type AgentMessage } from '@draht/agent-core';
import { defaultConvertToLlm } from '@draht/web-ui';

const agent = new Agent({
  convertToLlm: (messages: AgentMessage[]) => {
    // Extend defaultConvertToLlm for custom types
    return defaultConvertToLlm(messages);
  }
});
// AgentInterface will set streamFn and getApiKey defaults automatically
```

**Custom message types:**
```typescript
// Before: declaration merging on CustomMessages
declare module "@draht/web-ui" {
  interface CustomMessages {
    "my-message": MyMessage;
  }
}

// After: declaration merging on CustomAgentMessages
declare module "@draht/agent-core" {
  interface CustomAgentMessages {
    "my-message": MyMessage;
  }
}
```
