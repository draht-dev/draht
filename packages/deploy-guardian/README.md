# @draht/deploy-guardian

Pre-deploy safety checks for the Draht coding agent.

## Features

- **Safety Checks** — Validates deployments before they go live
- **Extension** — Registers as a Draht coding agent extension
- **Configurable** — Custom check rules per project

## Usage

```typescript
import { deployGuardianExtension } from "@draht/deploy-guardian";

// As a coding agent extension
export default deployGuardianExtension;
```

## Exports

| Export | Description |
|--------|-------------|
| `deployGuardianExtension` | Draht coding agent extension |
| `checks` | Built-in safety check implementations |
