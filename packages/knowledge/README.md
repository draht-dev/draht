# @draht/knowledge

Client knowledge base with vector search for the Draht coding agent.

## Features

- **Vector Store** — Chunk and embed documents for semantic search
- **Knowledge Manager** — Manage project-specific knowledge bases
- **Extension** — Registers as a Draht coding agent extension
- **Client Config** — Per-project knowledge configuration

## Usage

```typescript
import { KnowledgeManager, VectorStore, knowledgeExtension } from "@draht/knowledge";

// As a coding agent extension
export default knowledgeExtension;

// Direct usage
const store = new VectorStore(dbPath);
const results = await store.search(query, { limit: 5 });
```

## Exports

| Export | Description |
|--------|-------------|
| `KnowledgeManager` | Manages knowledge base lifecycle |
| `VectorStore` | Vector storage and semantic search |
| `knowledgeExtension` | Draht coding agent extension |
| `loadClientConfig` | Load per-project config |
