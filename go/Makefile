# Go 1.26 is not on PATH by default on this box, and there is no C compiler
# (cc/gcc/clang absent) — CGO_ENABLED=0 is mandatory. See README.md.
NIX_GO_BIN := /nix/store/gb0njhqswlc5n127ikgyikvq39r40l6f-go-1.26.4/bin
export PATH := $(NIX_GO_BIN):$(PATH)
export CGO_ENABLED := 0

# Phase 1 only builds kits for 6 grammars (design D2): typescript, tsx,
# javascript, python, go, rust. This keeps the binary ~6-8MB instead of the
# ~12.2MB all-206-grammars build.
GRAMMAR_TAGS := grammar_subset grammar_subset_typescript grammar_subset_tsx \
	grammar_subset_javascript grammar_subset_python grammar_subset_go grammar_subset_rust

.PHONY: build build-full test vet fmt parity clean

build:
	go build -ldflags="-s -w" -tags '$(GRAMMAR_TAGS)' -o bin/draht-tools ./cmd/draht-tools

# No grammar tags: registers all 206 bundled grammars. Exists solely to keep
# the size delta visible in review (see README.md's honesty statement).
build-full:
	go build -ldflags="-s -w" -o bin/draht-tools-full ./cmd/draht-tools

test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -l .

# Compares Go(--parser=regex) output against the CJS engine's MAP.json:
# root/packages/modules/edges/a stats subset (Phase 1) PLUS every Phase 2
# field (groups/containers/boundedContexts/callEdges/containerEdges/
# entryPoints/sinks/flows/lanes/boxes/symbolIndex/clusters/
# surprisingConnections/rationaleIndex/hotspots) and modules[*].depth/
# cluster. Self-contained by default: the test shells out to
# `node .../draht-tools.cjs map-graph
# --quiet` itself and compares against that fresh run. Pass PARITY_MAP to
# compare against an already-generated MAP.json instead (e.g. in a sandbox
# without `node` on PATH):
#   make parity PARITY_MAP=/path/to/CJS/MAP.json
parity:
	go test ./internal/graph -run TestParity_RegexParserMatchesCJSEngine -v $(if $(PARITY_MAP),-parity-map=$(PARITY_MAP))

clean:
	rm -rf bin
