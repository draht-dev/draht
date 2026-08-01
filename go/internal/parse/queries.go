package parse

// queryRev is folded into TreeSitter's Version(). Bump whenever ANY query
// string in this file changes; parse/version_test.go golden-hashes the
// concatenated query text and fails if it changes without a bump.
const queryRev = 2

// The four queries below (tsImportQuery, pyImportQuery, goImportQuery,
// rsImportQuery) reproduce the patterns validated by the gotreesitter spike's
// apiNotes against 6,273 real imports across 1,336 repo files with zero
// query-budget exhaustions. Every pattern from the spike is kept verbatim
// (same node shapes, same anchoring); the only additions are a handful of
// extra capture LABELS/patterns needed to satisfy parser.go's documented
// Namespace/"*" contract for bare wildcard forms the spike's capture names
// didn't distinguish (each is called out at its point of use below) — no
// existing pattern's matching behaviour is altered.
//
// The `@stmt` anchoring rule is load-bearing: `@stmt` must be the smallest
// node holding exactly one module specifier, so treesitter.go can group
// captures by `@stmt`'s byte offset. Getting this wrong silently merges
// distinct imports into one record (the historical Go
// import-declaration-vs-import-spec bug the spike found and fixed).

// tsImportQuery covers typescript, tsx and javascript — the three grammars
// share these node names.
const tsImportQuery = `
(import_statement source: (string (string_fragment) @source)) @stmt
(import_statement (import_clause (identifier) @default)) @stmt
(import_statement (import_clause (namespace_import (identifier) @namespace))) @stmt
(import_statement (import_clause (named_imports (import_specifier) @spec))) @stmt
(export_statement source: (string (string_fragment) @source)) @stmt
(export_statement (export_clause (export_specifier) @spec)) @stmt
(export_statement (namespace_export (identifier) @namespace)) @stmt
(call_expression
  function: (import)
  arguments: (arguments (string (string_fragment) @dynamic))) @stmt
(call_expression
  function: (identifier) @_fn
  arguments: (arguments (string (string_fragment) @require))
  (#eq? @_fn "require")) @stmt
(export_statement "*" source: (string (string_fragment) @wildcard_bare)) @stmt
`

// pyImportQuery. `import a.b, c` puts several modules under one
// import_statement, so it anchors on the name node itself (a node can carry
// two captures, @module and @stmt, at once). `from X import a, b` has one
// module and many symbols, so there the statement is the anchor.
const pyImportQuery = `
(import_statement name: (dotted_name) @module @stmt)
(import_statement name: (aliased_import name: (dotted_name) @module alias: (identifier) @alias) @stmt)
(import_from_statement module_name: (dotted_name) @module) @stmt
(import_from_statement module_name: (relative_import) @module) @stmt
(import_from_statement name: (dotted_name) @symbol) @stmt
(import_from_statement name: (aliased_import name: (dotted_name) @symbol alias: (identifier) @alias)) @stmt
(import_from_statement (wildcard_import) @symbol_wildcard) @stmt
`

// goImportQuery anchors on import_spec, NOT import_declaration: anchoring on
// the declaration collapses a 4-entry `import ( ... )` block into one record
// with three wrong aliases (the bug the spike found and fixed).
const goImportQuery = `
(import_spec path: (interpreted_string_literal (interpreted_string_literal_content) @module)) @stmt
(import_spec name: (_) @alias path: (interpreted_string_literal (interpreted_string_literal_content) @module)) @stmt
`

const rsImportQuery = `
(use_declaration argument: (scoped_identifier) @path) @stmt
(use_declaration argument: (scoped_use_list path: (_) @path list: (use_list (identifier) @symbol))) @stmt
(use_declaration argument: (scoped_use_list path: (_) @path list: (use_list (use_as_clause path: (_) @symbol alias: (_) @alias)))) @stmt
(use_declaration argument: (use_wildcard) @path_wildcard) @stmt
(use_declaration argument: (use_as_clause path: (_) @path alias: (_) @alias)) @stmt
(extern_crate_declaration name: (identifier) @crate) @stmt
(mod_item name: (identifier) @mod) @stmt
`

// The queries below extend coverage beyond the spike's D2 scope (6 grammars)
// to every grammar the spike proved viable (Q3/Q4 findings): java, kotlin,
// swift, ruby, php, csharp (grammar name "c_sharp"), c, cpp, shell (grammar
// name "bash"). Each was hand-authored against real gotreesitter@v0.47.1
// parses of representative snippets (node shapes verified via Node.SExpr and
// field-name dumps, not guessed) and compiled successfully.
//
// Two grammar bugs the spike found (Swift `if let`, C++ qualified brace-init)
// live inside statement/expression bodies, not import/using/include
// declarations, so they do not affect these queries.

// javaImportQuery. `import com.foo.bar.*;` matches BOTH the plain
// scoped_identifier pattern and the asterisk pattern (same @module value from
// each — idempotent, not a conflict). A single-segment import (`import Foo;`)
// has a bare `identifier` child instead of `scoped_identifier`.
const javaImportQuery = `
(import_declaration (scoped_identifier) @module (asterisk) @wildcard) @stmt
(import_declaration (scoped_identifier) @module) @stmt
(import_declaration (identifier) @module) @stmt
`

// kotlinImportQuery.
const kotlinImportQuery = `
(import_header (identifier) @module) @stmt
(import_header (import_alias (type_identifier) @alias)) @stmt
(import_header (wildcard_import) @wildcard) @stmt
`

// swiftImportQuery. Attributes (`@testable import X`) and submodule imports
// (`import class Foo.Bar`) both still expose a single `identifier` child
// holding the full dotted path.
const swiftImportQuery = `
(import_declaration (identifier) @module) @stmt
`

// rubyImportQuery matches only `require`/`require_relative` calls (not every
// call), via the #eq? predicate on the method name — mirrors the TS/JS
// require() pattern.
const rubyImportQuery = `
(call method: (identifier) @_m arguments: (argument_list (string (string_content) @module)) (#eq? @_m "require")) @stmt
(call method: (identifier) @_m arguments: (argument_list (string (string_content) @module)) (#eq? @_m "require_relative")) @stmt
`

// phpImportQuery. require/require_once/include/include_once may hold either
// a single-quoted `string` node or a double-quoted `encapsed_string` node
// (verified: PHP's grammar lexes them differently) — the `[...]` alternation
// covers both. `include`'s argument is often parenthesized
// (`include('x.php')`); the bare form is covered too. `use` statements
// (namespace imports) capture the qualified_name/name path and, when present,
// an aliasing `as` clause. The `.` anchor before (qualified_name)/(name)
// restricts the match to the FIRST named child of namespace_use_clause: with
// an alias (`use App\Foo as F;`), namespace_use_clause's alias identifier is
// ALSO an unconstrained-field `name` node and — without the anchor — matches
// the plain-`name` pattern too, clobbering @module with the alias text.
const phpImportQuery = `
(require_expression [(string (string_content) @module) (encapsed_string (string_content) @module)]) @stmt
(require_once_expression [(string (string_content) @module) (encapsed_string (string_content) @module)]) @stmt
(include_expression [(string (string_content) @module) (encapsed_string (string_content) @module)]) @stmt
(include_expression (parenthesized_expression [(string (string_content) @module) (encapsed_string (string_content) @module)])) @stmt
(include_once_expression [(string (string_content) @module) (encapsed_string (string_content) @module)]) @stmt
(include_once_expression (parenthesized_expression [(string (string_content) @module) (encapsed_string (string_content) @module)])) @stmt
(namespace_use_declaration (namespace_use_clause . (qualified_name) @module)) @stmt
(namespace_use_declaration (namespace_use_clause . (name) @module)) @stmt
(namespace_use_declaration (namespace_use_clause alias: (name) @alias)) @stmt
`

// csharpImportQuery. `using Foo = System.Bar;` (an alias directive) has TWO
// candidate children of a plain, unconstrained-field pattern: the alias name
// ("Foo", field "name") and the aliased target ("System.Bar", no field). The
// @module_alt bucket exists precisely to avoid a match-order-dependent
// (non-deterministic) overwrite: treesitter.go reconciles module vs
// module_alt deterministically at finalize time (module wins when present),
// regardless of the order NextMatch() returns the two independent pattern
// matches in.
const csharpImportQuery = `
(using_directive (identifier) @module_alt) @stmt
(using_directive (qualified_name) @module) @stmt
(using_directive name: (identifier) @alias) @stmt
`

// cImportQuery / cppImportQuery. system_lib_string (`<stdio.h>`) includes its
// angle brackets in Node.Text — captured as @module_angle so treesitter.go
// knows to trim them; string_literal's string_content excludes its quotes
// already, same as every other quoted-string capture in this file.
const cImportQuery = `
(preproc_include path: (system_lib_string) @module_angle) @stmt
(preproc_include path: (string_literal (string_content) @module)) @stmt
`

// cppImportQuery additionally covers C++20 `import foo.mod;` module
// declarations, on top of the same #include forms as C.
const cppImportQuery = cImportQuery + `
(import_declaration (module_name) @module) @stmt
`

// bashImportQuery matches `source file` and its POSIX synonym `. file`,
// anchored via the `.` immediate-child operator so that only the FIRST
// argument word is captured (a command like `source lib.sh arg1 arg2` must
// not turn arg1/arg2 into spurious import records).
// bashImportQuery covers `source X` and `. X` in the three ways X is written.
//
// The bare (word) patterns alone miss most real scripts: shellcheck tells
// everyone to quote paths, so `source "./lib/common.sh"` is the common form.
//
// The double-quoted pattern anchors string_content as the string's ONLY child
// (`. … .`). That is deliberate and load-bearing: a string containing an
// expansion — `"$SCRIPT_DIR/lib.sh"` — has additional children and therefore
// does not match, so it is skipped rather than resolved against a path that
// only exists at runtime. Recall is lower; precision stays exact.
const bashImportQuery = `
(command name: (command_name (word) @_cmd) . argument: (word) @path (#eq? @_cmd "source")) @stmt
(command name: (command_name (word) @_cmd) . argument: (word) @path (#eq? @_cmd ".")) @stmt
(command name: (command_name (word) @_cmd) . argument: (string . (string_content) @path .) (#eq? @_cmd "source")) @stmt
(command name: (command_name (word) @_cmd) . argument: (string . (string_content) @path .) (#eq? @_cmd ".")) @stmt
(command name: (command_name (word) @_cmd) . argument: (raw_string) @path_raw (#eq? @_cmd "source")) @stmt
(command name: (command_name (word) @_cmd) . argument: (raw_string) @path_raw (#eq? @_cmd ".")) @stmt
`

// ImportQueryFor returns the compiled S-expression query text for the
// gotreesitter grammar name (e.g. "typescript", "tsx", "javascript",
// "python", "go", "rust", "java", "kotlin", "swift", "ruby", "php",
// "c_sharp", "c", "cpp", "bash"). Returns "" for any grammar without an
// authored import query — callers must treat that as "no import extraction
// for this grammar" rather than an error.
func ImportQueryFor(grammar string) string {
	switch grammar {
	case "typescript", "tsx", "javascript":
		return tsImportQuery
	case "python":
		return pyImportQuery
	case "go":
		return goImportQuery
	case "rust":
		return rsImportQuery
	case "java":
		return javaImportQuery
	case "kotlin":
		return kotlinImportQuery
	case "swift":
		return swiftImportQuery
	case "ruby":
		return rubyImportQuery
	case "php":
		return phpImportQuery
	case "c_sharp":
		return csharpImportQuery
	case "c":
		return cImportQuery
	case "cpp":
		return cppImportQuery
	case "bash":
		return bashImportQuery
	}
	return ""
}
