# Phase 5 Context: Client Knowledge Base Extension

## Domain Boundary
This phase creates a knowledge persistence layer for coding-agent clients. Each client gets an isolated vector store for AGENTS.md, past decisions, and patterns. The extension auto-injects relevant context on session start.

## Decisions

### Storage & Vector DB
- **Engine:** Zvec (local SQLite + OpenAI embeddings) — same as clawd memory system, proven and local-first
- **Namespace isolation:** Each client gets a separate Zvec index directory under `~/.draht/knowledge/{client-slug}/`
- **Embedding model:** OpenAI text-embedding-3-small (same as existing Zvec setup)
- **Index format:** SQLite with cosine similarity search

### Extension Architecture
- **Package location:** `packages/knowledge/` as @draht/knowledge library, with extension entry point
- **Extension type:** Coding agent extension following Pi Agent factory pattern
- **Context injection:** On `session_start` event, read client config, search knowledge base, inject as system prompt prefix
- **Client detection:** Read `.draht/client.json` or `AGENTS.md` from cwd to identify active client

### Knowledge Operations
- **Indexing:** Auto-index AGENTS.md, decision logs, and explicitly marked files
- **Search:** Semantic search with mode support (decide, connect, fuzzy — like Zvec recall modes)
- **CLI commands:** `/knowledge index`, `/knowledge search <query>`, `/knowledge forget <id>`
- **Auto-update:** Re-index on file changes detected during session

### Data Model
- **Chunk size:** ~500 tokens per chunk (matching Zvec defaults)
- **Metadata:** source file, client slug, timestamp, chunk type (decision/convention/pattern)
- **Deduplication:** Hash-based dedup on content to avoid re-indexing unchanged files

## Claude's Discretion
- Exact chunk overlap strategy
- Internal module structure within packages/knowledge/
- Error message wording
- Logging verbosity levels

## Deferred Ideas
- Cross-client knowledge sharing (Phase 7+ if needed)
- Cloud-synced knowledge (out of scope — local-first only)
- Knowledge pruning/archival strategies
