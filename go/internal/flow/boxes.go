package flow

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/draht-dev/draht/go/internal/model"
)

// layerOrderInternal is LAYER_ORDER_INTERNAL (draht-tools.cjs:2848-ish): the
// stable sort's declaration-order tie-break, which is also why an
// entirely-empty container lands on "presentation" (all counts tie at 0 and
// the first element wins).
var layerOrderInternal = []string{"presentation", "application", "domain", "infrastructure", "support"}

// layerColorsInternal is LAYER_COLORS_INTERNAL.
var layerColorsInternal = map[string]string{
	"presentation":   "#79c0ff",
	"application":    "#7ee787",
	"domain":         "#d2a8ff",
	"infrastructure": "#f0883e",
	"support":        "#8b949e",
}

// laneForModules picks a container's dominant layer (LAYER_ORDER_INTERNAL,
// stable-sorted by descending per-layer module count) and returns the box
// lane (with support remapped to application) plus the box color, which is
// derived from the PRE-remap dominant layer (draht-tools.cjs's box builder:
// `lane: lane === "support" ? "application" : lane, color: LAYER_COLORS[lane]`).
func laneForModules(mods []*model.Module) (lane, color string) {
	counts := make(map[string]int, len(layerOrderInternal))
	for _, m := range mods {
		counts[m.Layer]++
	}
	order := append([]string(nil), layerOrderInternal...)
	sort.SliceStable(order, func(i, j int) bool { return counts[order[i]] > counts[order[j]] })

	dominant := order[0]
	lane = dominant
	if lane == "support" {
		lane = "application"
	}
	color = layerColorsInternal[dominant]
	if color == "" {
		color = "#8b949e"
	}
	return lane, color
}

// ContainerLane computes the swim-lane and color a single container would
// receive, by filtering modules to that container and delegating to the
// same rule BuildBoxes uses.
func ContainerLane(containerID string, modules []model.Module) (lane, color string) {
	var mods []*model.Module
	for i := range modules {
		if containerOf2(&modules[i]) == containerID {
			mods = append(mods, &modules[i])
		}
	}
	return laneForModules(mods)
}

// BuildBoxes ports draht-tools.cjs:2848-2884: the actor box, then one
// package box per container (in containers order), then one sink box per
// distinct sinkKind encountered across every curated flow's steps, in
// first-encounter order. Sink-box ids can legitimately repeat (two kinds
// sharing a SinkLabel, e.g. fs:write/fs:read both -> "sink:Filesystem") —
// that duplication is intentional and must not be deduped.
func BuildBoxes(containers []model.Container, modules []model.Module, flows []json.RawMessage) []Box {
	boxes := []Box{{
		ID:       "actor:user",
		Lane:     "actor",
		Title:    "User",
		Sublabel: "CLI / HTTP / library caller",
		Color:    "#ff9bd4",
	}}

	modulesByContainer := make(map[string][]*model.Module)
	for i := range modules {
		m := &modules[i]
		c := containerOf2(m)
		modulesByContainer[c] = append(modulesByContainer[c], m)
	}

	for _, c := range containers {
		mods := modulesByContainer[c.ID]
		lane, color := laneForModules(mods)

		entryCount := 0
		sinkSet := newOrderedSet()
		for _, m := range mods {
			if m.EntryPoint != nil {
				entryCount++
			}
			for _, s := range m.Sinks {
				sinkSet.add(s)
			}
		}

		sublabel := fmt.Sprintf("%d modules", len(mods))
		if entryCount > 0 {
			sublabel += fmt.Sprintf(" · %d entry", entryCount)
		}
		if sinkSet.len() > 0 {
			shown := sinkSet.items
			if len(shown) > 3 {
				shown = shown[:3]
			}
			sublabel += " · " + strings.Join(shown, ", ")
		}

		sinks := append([]string{}, sinkSet.items...)
		boxes = append(boxes, Box{
			ID:          c.ID,
			Lane:        lane,
			Title:       c.Name,
			Sublabel:    sublabel,
			Color:       color,
			Kind:        "package",
			ModuleCount: len(mods),
			HasEntry:    entryCount > 0,
			Sinks:       sinks,
		})
	}

	allSinkKinds := newOrderedSet()
	for _, raw := range flows {
		var decoded struct {
			Steps []struct {
				SinkKind string `json:"sinkKind"`
			} `json:"steps"`
		}
		if err := json.Unmarshal(raw, &decoded); err != nil {
			continue
		}
		for _, s := range decoded.Steps {
			if s.SinkKind != "" {
				allSinkKinds.add(s.SinkKind)
			}
		}
	}
	for _, kind := range allSinkKinds.items {
		title := SinkLabel[kind]
		if title == "" {
			title = kind
		}
		boxes = append(boxes, Box{
			ID:       SinkBoxID(kind),
			Lane:     "sinks",
			Title:    title,
			Sublabel: kind,
			Color:    "#ff7b72",
			Kind:     "sink",
		})
	}

	return boxes
}
