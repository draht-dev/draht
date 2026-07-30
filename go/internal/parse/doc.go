// Package parse extracts module import/export specifiers from source bytes.
// It defines the Parser swap seam (tree-sitter vs regex implementations) and
// imports nothing but gotreesitter — no scan, no extract, no model — to keep
// the module's dependency graph acyclic.
package parse
