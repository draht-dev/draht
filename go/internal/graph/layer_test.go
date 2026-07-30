package graph

import (
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

func TestClassifyLayer(t *testing.T) {
	cases := []struct {
		name      string
		rel       string
		sinks     []string
		hasRoutes bool
		isBin     bool
		isExport  bool
		want      string
	}{
		{name: "isBin flag alone forces presentation", rel: "packages/ai/src/whatever.ts", isBin: true, want: model.LayerPresentation},
		{name: "cli filename", rel: "packages/foo/src/cli.ts", want: model.LayerPresentation},
		{name: "bin filename", rel: "packages/foo/bin.js", want: model.LayerPresentation},
		{name: "main filename", rel: "src/main.mjs", want: model.LayerPresentation},
		{name: "cli directory", rel: "packages/foo/cli/run.ts", want: model.LayerPresentation},
		{name: "bin directory", rel: "packages/foo/bin/tool.ts", want: model.LayerPresentation},
		{name: "hasRoutes forces presentation", rel: "packages/foo/src/thing.ts", hasRoutes: true, want: model.LayerPresentation},
		{name: "routes directory", rel: "packages/foo/routes/users.ts", want: model.LayerPresentation},
		{name: "handlers directory (http, not application)", rel: "packages/foo/handlers/index.ts", want: model.LayerPresentation},
		{name: "api directory", rel: "packages/foo/api/v1.ts", want: model.LayerPresentation},
		{name: "domain directory", rel: "packages/foo/domain/order.ts", want: model.LayerDomain},
		{name: "entities directory", rel: "packages/foo/entities/user.ts", want: model.LayerDomain},
		{name: "value-objects directory", rel: "packages/foo/value-objects/money.ts", want: model.LayerDomain},
		{name: "services directory", rel: "packages/foo/services/billing.ts", want: model.LayerApplication},
		{name: "use-cases directory (hyphen)", rel: "packages/foo/use-cases/checkout.ts", want: model.LayerApplication},
		{name: "use_cases directory (underscore)", rel: "packages/foo/use_cases/checkout.ts", want: model.LayerApplication},
		{name: "workflows directory", rel: "packages/foo/workflows/run.ts", want: model.LayerApplication},
		{name: "infra sink: db", rel: "packages/foo/src/repo.ts", sinks: []string{"db:sql"}, want: model.LayerInfrastructure},
		{name: "infra sink: net", rel: "packages/foo/src/client.ts", sinks: []string{"net:fetch"}, want: model.LayerInfrastructure},
		{name: "infra sink: fs:write exact", rel: "packages/foo/src/writer.ts", sinks: []string{"fs:write"}, want: model.LayerInfrastructure},
		{name: "fs:read is NOT an infra sink", rel: "packages/foo/src/reader.ts", sinks: []string{"fs:read"}, want: model.LayerSupport},
		{name: "infra sink: process:exec", rel: "packages/foo/src/runner.ts", sinks: []string{"process:exec"}, want: model.LayerInfrastructure},
		{name: "utils directory, not exported", rel: "packages/foo/utils/format.ts", want: model.LayerSupport},
		{name: "utils directory but exported -> application", rel: "packages/foo/utils/format.ts", isExport: true, want: model.LayerApplication},
		{name: "core directory, not exported", rel: "packages/foo/core/engine.ts", want: model.LayerSupport},
		{name: "types directory (optional s)", rel: "packages/foo/types/index.ts", want: model.LayerSupport},
		{name: "type directory (singular)", rel: "packages/foo/type/index.ts", want: model.LayerSupport},
		{name: "no match, exported -> application", rel: "packages/foo/random/thing.ts", isExport: true, want: model.LayerApplication},
		{name: "no match, not exported -> support (default)", rel: "packages/foo/random/thing.ts", want: model.LayerSupport},
		{name: "case-insensitive matching", rel: "Packages/Foo/CLI/Run.ts", want: model.LayerPresentation},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ClassifyLayer(c.rel, c.sinks, c.hasRoutes, c.isBin, c.isExport)
			if got != c.want {
				t.Errorf("ClassifyLayer(%q, %v, hasRoutes=%v, isBin=%v, isExport=%v) = %q, want %q",
					c.rel, c.sinks, c.hasRoutes, c.isBin, c.isExport, got, c.want)
			}
		})
	}
}

// TestClassifyLayerPrecedence locks in the exact branch order from
// draht-tools.cjs:1573-1584: presentation short-circuits before domain even
// when a path would ALSO match a domain segment.
func TestClassifyLayerPrecedence(t *testing.T) {
	got := ClassifyLayer("packages/foo/cli/domain/thing.ts", nil, false, false, false)
	if got != model.LayerPresentation {
		t.Errorf("got %q, want %q (cli/ must win over domain/)", got, model.LayerPresentation)
	}
}
