# Changelog

## [2026.11.19-1] - 2026-11-19

### Added

- run kg in the Go engine with output identical to the JavaScript engine
- align Go engine with CJS parity
- kg engine — graphify-parity symbol-level knowledge graph
- graphify parity for the living map — barrel exports, query recall, Insights view
- kg engine — graphify-parity symbol-level knowledge graph
- graphify parity for the living map — barrel exports, query recall, Insights view

### Fixed

- kg reads comparisons and pattern defaults in parameter lists correctly
- kg keeps calls in default values and reads parameter lists by binding
- kg no longer links shadowed names or type signatures as calls
- resolve kg workspace subpath imports through package exports
- keep star-barrel names whose re-export target stars them in
- keep kg declaration headers, type imports and wiki pages accurate
- resolve local export aliases before comparing star-export binding origins
- accept generic class headers, compare star origins by binding, bound wiki names
- address Greptile round-6 findings on kg parsing and star origins
- use lookbehind in kg call scans so nested calls are not consumed
- harden default-decl regex, retract stale star copies, isolate query test
- keep multiline function headers open and guard namespace-call receivers
- address Greptile review findings on kg engine and star expansion
- classify named default declarations as the default export
- address CodeRabbit re-review findings on export extraction
- address CodeRabbit review findings on knowledge-graph parity
- address Greptile P1 findings — expansion fixpoint, Go aliases, Rust impl methods
