# Changelog

## [Unreleased]

### Added

- Added `@draht/durable`, a durable agent harness: conversations, model turns, tool calls, tasks and documents are committed to storage before anything is shown, and a restarted process continues from the last checkpoint. Ships memory, IndexedDB, JSONL and SQLite storage (Node and Cloudflare Durable Objects), a storage on Chord's store (`./storage/store`), the file tools, code mode, tool search and image fitting. Carried from upstream `packages/durable` at badlogic/pi-mono@32c71a6d4.
