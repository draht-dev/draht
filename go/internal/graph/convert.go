package graph

import (
	"github.com/draht-dev/draht/go/internal/extract"
	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/scan"
)

// nonNilExports/etc. below convert the cacheable extract.* records into
// their model.* wire equivalents, filling in the pointer-vs-empty-string
// nullability that Facts (a compact cache payload) doesn't bother with.

func convertExports(in []extract.Export) []model.Export {
	out := make([]model.Export, len(in))
	for i, e := range in {
		var doc *string
		if e.Doc != "" {
			d := e.Doc
			doc = &d
		}
		out[i] = model.Export{Name: e.Name, Kind: e.Kind, Line: e.Line, Doc: doc}
	}
	return out
}

func convertSymbols(in []extract.Symbol) []model.Symbol {
	out := make([]model.Symbol, len(in))
	for i, s := range in {
		out[i] = model.Symbol{Name: s.Name, Kind: s.Kind, Line: s.Line, Exported: s.Exported}
	}
	return out
}

func convertSinkSites(in []extract.SinkSite) []model.SinkSite {
	out := make([]model.SinkSite, len(in))
	for i, s := range in {
		var inFn *string
		if s.InFunction != "" {
			f := s.InFunction
			inFn = &f
		}
		out[i] = model.SinkSite{Kind: s.Kind, Line: s.Line, Snippet: s.Snippet, InFunction: inFn}
	}
	return out
}

func convertRoutes(in []extract.Route) []model.Route {
	out := make([]model.Route, len(in))
	for i, r := range in {
		out[i] = model.Route{Method: r.Method, Path: r.Path}
	}
	return out
}

// convertPackage maps a scan.Package (which additionally carries raw
// manifest fields graph-internal code needs, like Bin/Main/ExportLeaves)
// onto the model.Package wire shape.
func convertPackage(p scan.Package) model.Package {
	return model.Package{
		Name:              p.Name,
		Version:           p.Version,
		Path:              p.Path,
		Description:       p.Description,
		Dependencies:      nonNilStrings(p.Dependencies),
		DevDependencies:   nonNilStrings(p.DevDependencies),
		PeerDependencies:  nonNilStrings(p.PeerDependencies),
		WorkspaceDeps:     nonNilStrings(p.WorkspaceDeps),
		WorkspacePatterns: p.WorkspacePatterns,
	}
}

func nonNilStrings(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
