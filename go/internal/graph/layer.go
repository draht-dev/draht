package graph

import (
	"regexp"
	"strings"

	"github.com/draht-dev/draht/go/internal/model"
)

// Layer classification regexes, ported verbatim from
// draht-tools.cjs:1573-1584. Each is matched against the lowercased
// repo-relative path.
var (
	layerCLIFileRe = regexp.MustCompile(`/(?:cli|bin|main)\.(?:ts|js|mjs|cjs)$`)
	layerCLIDirRe  = regexp.MustCompile(`(^|/)(cli|bin)/`)
	layerHTTPDirRe = regexp.MustCompile(`(^|/)(routes|handlers|controllers|api|http|server)/`)
	layerDomainRe  = regexp.MustCompile(`(^|/)(domain|entities|aggregates|models|value-objects)/`)
	layerAppRe     = regexp.MustCompile(`(^|/)(services|use[-_]?cases|application|workflows|commands|handlers|tools|features|modules)/`)
	layerSupportRe = regexp.MustCompile(`(^|/)(utils|helpers|lib|shared|common|types?|core)/`)
)

// ClassifyLayer is the verbatim port of visClassifyLayer
// (draht-tools.cjs:1573-1584): a path + sinks heuristic that assigns each
// module to one of the 5 architectural layers.
func ClassifyLayer(rel string, sinks []string, hasRoutes, isBin, isExport bool) string {
	p := strings.ToLower(rel)

	if isBin || layerCLIFileRe.MatchString("/"+p) || layerCLIDirRe.MatchString(p) {
		return model.LayerPresentation
	}
	if hasRoutes || layerHTTPDirRe.MatchString(p) {
		return model.LayerPresentation
	}
	if layerDomainRe.MatchString(p) {
		return model.LayerDomain
	}
	if layerAppRe.MatchString(p) {
		return model.LayerApplication
	}

	isInfraSink := false
	for _, s := range sinks {
		if strings.HasPrefix(s, "db:") || strings.HasPrefix(s, "net:") ||
			s == model.SinkFSWrite || strings.HasPrefix(s, "process:exec") {
			isInfraSink = true
			break
		}
	}
	if isInfraSink {
		return model.LayerInfrastructure
	}

	if layerSupportRe.MatchString(p) && !isExport {
		return model.LayerSupport
	}
	if isExport {
		return model.LayerApplication
	}
	return model.LayerSupport
}
