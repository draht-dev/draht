// Package main exercises go import extraction (also not edged, per D3 —
// edges[] is TS/JS only in Phase 1).
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Println(os.Args)
}
