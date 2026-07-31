// Command grammar-tags prints the grammar_subset build tags the shipped
// draht-graph binary must be compiled with. Consumed by go/Makefile,
// scripts/build-graph-binaries.sh and .github/workflows/ci.yml — this is
// the ONLY place the tag list is allowed to come from. Never hand-write
// this list anywhere else; see internal/langset's package doc for why.
package main

import (
	"fmt"
	"strings"

	"github.com/draht-dev/draht/go/internal/langset"
)

func main() {
	fmt.Println(strings.Join(langset.BuildTags(langset.CLILanguages), " "))
}
