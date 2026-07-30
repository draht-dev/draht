package cluster

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

func mod(path string, pkg *string) model.Module {
	return model.Module{ID: path, Path: path, Package: pkg, Layer: model.LayerSupport}
}

func imp(from, to string) model.Edge {
	return model.Edge{From: from, To: to, Kind: model.EdgeKindImport, Confidence: model.ConfidenceExtracted}
}

func pstr(s string) *string { return &s }

// TestCompute_TwoClearCommunities builds two densely-interconnected
// directory communities linked by a single weak cross edge, plus a pile of
// unrelated single-node modules to keep the community sizes well under the
// 25% oversize-split threshold. It asserts the two communities never share
// a final cluster, even though a weak edge crosses between them.
func TestCompute_TwoClearCommunities(t *testing.T) {
	var modules []model.Module
	var edges []model.Edge

	commA := []string{"comm/a/mod1.ts", "comm/a/mod2.ts", "comm/a/mod3.ts"}
	commB := []string{"comm/b/mod1.ts", "comm/b/mod2.ts", "comm/b/mod3.ts"}
	for _, p := range commA {
		modules = append(modules, mod(p, nil))
	}
	for _, p := range commB {
		modules = append(modules, mod(p, nil))
	}
	// Fully connect each community internally.
	for i := 0; i < len(commA); i++ {
		for j := i + 1; j < len(commA); j++ {
			edges = append(edges, imp(commA[i], commA[j]))
		}
	}
	for i := 0; i < len(commB); i++ {
		for j := i + 1; j < len(commB); j++ {
			edges = append(edges, imp(commB[i], commB[j]))
		}
	}
	// One weak cross-community edge.
	edges = append(edges, imp(commA[0], commB[0]))

	// Padding: 14 unrelated singleton modules (distinct top-level dirs, no
	// edges) so total = 20 and 20*0.25 = 5 comfortably exceeds each
	// 3-member community — the oversize-split path must not fire here.
	for i := 0; i < 14; i++ {
		modules = append(modules, mod(fmt.Sprintf("dummy%d/f.ts", i), nil))
	}

	res := Compute(modules, edges)

	// All of community A must share one cluster id; all of community B
	// must share a different one.
	clusterA := res.ClusterOf[commA[0]]
	for _, id := range commA {
		if got := res.ClusterOf[id]; got != clusterA {
			t.Errorf("community A member %s: cluster %q, want %q", id, got, clusterA)
		}
	}
	clusterB := res.ClusterOf[commB[0]]
	for _, id := range commB {
		if got := res.ClusterOf[id]; got != clusterB {
			t.Errorf("community B member %s: cluster %q, want %q", id, got, clusterB)
		}
	}
	if clusterA == clusterB {
		t.Fatalf("communities A and B collapsed into the same cluster %q despite the weak cross edge", clusterA)
	}

	// Every module must land in exactly one cluster.
	if len(res.ClusterOf) != len(modules) {
		t.Fatalf("ClusterOf has %d entries, want %d (one per module)", len(res.ClusterOf), len(modules))
	}
}

// TestCompute_OversizedCommunitySplits builds one edge-less community of 12
// modules (all sharing a package, so they bucket into a single byLabel
// group) that exceeds CLUSTER_MAX_SHARE of a 40-module total, split evenly
// across two directories that only diverge from the initial seed depth. It
// asserts the recursive split fires and produces exactly the two
// directory-aligned sub-clusters.
func TestCompute_OversizedCommunitySplits(t *testing.T) {
	pkg := pstr("samepkg")
	var modules []model.Module

	var groupP, groupQ []string
	for i := 0; i < 6; i++ {
		p := fmt.Sprintf("root/lib/groupP/mod%d.ts", i)
		q := fmt.Sprintf("root/lib/groupQ/mod%d.ts", i)
		groupP = append(groupP, p)
		groupQ = append(groupQ, q)
		modules = append(modules, mod(p, pkg), mod(q, pkg))
	}
	// Padding to push total to 40, so the 12-member community (30%) is
	// oversized relative to CLUSTER_MAX_SHARE (25%) while each 6-member
	// half (15%) is not.
	for i := 0; i < 28; i++ {
		modules = append(modules, mod(fmt.Sprintf("pad%d/f.ts", i), nil))
	}

	res := Compute(modules, nil)

	if got, want := len(res.ClusterOf), len(modules); got != want {
		t.Fatalf("ClusterOf has %d entries, want %d", got, want)
	}

	clusterP := res.ClusterOf[groupP[0]]
	for _, id := range groupP {
		if got := res.ClusterOf[id]; got != clusterP {
			t.Errorf("groupP member %s: cluster %q, want %q", id, got, clusterP)
		}
	}
	clusterQ := res.ClusterOf[groupQ[0]]
	for _, id := range groupQ {
		if got := res.ClusterOf[id]; got != clusterQ {
			t.Errorf("groupQ member %s: cluster %q, want %q", id, got, clusterQ)
		}
	}
	if clusterP == clusterQ {
		t.Fatalf("oversized 12-member community was not split: groupP and groupQ share cluster %q", clusterP)
	}

	// Find the two clusters and check their sizes.
	var sizeP, sizeQ int
	for _, c := range res.Clusters {
		if c.ID == clusterP {
			sizeP = c.Size
		}
		if c.ID == clusterQ {
			sizeQ = c.Size
		}
	}
	if sizeP != 6 {
		t.Errorf("cluster %q size = %d, want 6", clusterP, sizeP)
	}
	if sizeQ != 6 {
		t.Errorf("cluster %q size = %d, want 6", clusterQ, sizeQ)
	}
}

// TestCompute_HubDoesNotBroadcast builds a barrel-file hub connected only
// to four otherwise-unconnected leaf modules. If the hub's own label were
// allowed to broadcast (textbook synchronous LPA), all four leaves would
// converge on the hub's label and end up in one shared cluster. The port
// must suppress hub votes, so each leaf instead keeps its own
// directory-derived identity and none of them merge with each other or
// with the hub via the hub's broadcast.
func TestCompute_HubDoesNotBroadcast(t *testing.T) {
	hub := "hub/index.ts" // matches CLUSTER_BARREL_RE unconditionally
	leaves := []string{"leaf0/only.ts", "leaf1/only.ts", "leaf2/only.ts", "leaf3/only.ts"}

	var modules []model.Module
	modules = append(modules, mod(hub, nil))
	var edges []model.Edge
	for _, l := range leaves {
		modules = append(modules, mod(l, nil))
		edges = append(edges, imp(hub, l))
	}

	res := Compute(modules, edges)

	seen := make(map[string]string) // cluster id -> first module id that used it
	all := append([]string{hub}, leaves...)
	for _, id := range all {
		cid := res.ClusterOf[id]
		if other, dup := seen[cid]; dup {
			t.Errorf("module %s shares cluster %q with %s — hub broadcast leaked a shared label", id, cid, other)
		}
		seen[cid] = id
	}
	if len(seen) != len(all) {
		t.Fatalf("expected %d distinct clusters (no hub-mediated merges), got %d", len(all), len(seen))
	}
}

// buildDeterminismFixture returns a moderately rich graph combining
// multiple communities, an oversized community, and a barrel hub, used to
// exercise every code path (propagation, recursive split, hub suppression)
// in a single determinism check.
func buildDeterminismFixture() ([]model.Module, []model.Edge) {
	var modules []model.Module
	var edges []model.Edge

	// Two small tightly-linked communities.
	commA := []string{"comm/a/mod1.ts", "comm/a/mod2.ts", "comm/a/mod3.ts"}
	commB := []string{"comm/b/mod1.ts", "comm/b/mod2.ts", "comm/b/mod3.ts"}
	for _, p := range append(append([]string{}, commA...), commB...) {
		modules = append(modules, mod(p, nil))
	}
	for i := 0; i < len(commA); i++ {
		for j := i + 1; j < len(commA); j++ {
			edges = append(edges, imp(commA[i], commA[j]))
		}
	}
	for i := 0; i < len(commB); i++ {
		for j := i + 1; j < len(commB); j++ {
			edges = append(edges, imp(commB[i], commB[j]))
		}
	}
	edges = append(edges, imp(commA[0], commB[0]))

	// An oversized edge-less community split across two directories.
	pkg := pstr("samepkg")
	for i := 0; i < 6; i++ {
		modules = append(modules, mod(fmt.Sprintf("root/lib/groupP/mod%d.ts", i), pkg))
		modules = append(modules, mod(fmt.Sprintf("root/lib/groupQ/mod%d.ts", i), pkg))
	}

	// A barrel hub with several leaves.
	hub := "hub/index.ts"
	modules = append(modules, mod(hub, nil))
	for i := 0; i < 4; i++ {
		leaf := fmt.Sprintf("leaf%d/only.ts", i)
		modules = append(modules, mod(leaf, nil))
		edges = append(edges, imp(hub, leaf))
	}

	// Padding.
	for i := 0; i < 10; i++ {
		modules = append(modules, mod(fmt.Sprintf("pad%d/f.ts", i), nil))
	}

	return modules, edges
}

func shuffledModules(mods []model.Module, seed int64) []model.Module {
	r := rand.New(rand.NewSource(seed))
	out := append([]model.Module(nil), mods...)
	r.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	return out
}

func shuffledEdges(edges []model.Edge, seed int64) []model.Edge {
	r := rand.New(rand.NewSource(seed))
	out := append([]model.Edge(nil), edges...)
	r.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	return out
}

// TestCompute_Determinism runs Compute 10 times over permuted copies of the
// same logical graph (different module/edge slice orderings, since Go map
// iteration is randomized per-process) and asserts every run produces
// byte-identical Clusters and ClusterOf. This is the concurrency/order gate
// analogous to the jobs=1 vs jobs=8 determinism check used elsewhere in
// this port.
func TestCompute_Determinism(t *testing.T) {
	baseModules, baseEdges := buildDeterminismFixture()
	baseline := Compute(baseModules, baseEdges)

	for i := 0; i < 10; i++ {
		mods := shuffledModules(baseModules, int64(1000+i))
		edges := shuffledEdges(baseEdges, int64(2000+i))
		got := Compute(mods, edges)

		if !reflect.DeepEqual(got.ClusterOf, baseline.ClusterOf) {
			t.Fatalf("run %d: ClusterOf differs from baseline\nbaseline=%#v\ngot=%#v", i, baseline.ClusterOf, got.ClusterOf)
		}
		if !reflect.DeepEqual(got.Clusters, baseline.Clusters) {
			t.Fatalf("run %d: Clusters differs from baseline\nbaseline=%#v\ngot=%#v", i, baseline.Clusters, got.Clusters)
		}
	}
}

func TestApplyClusters(t *testing.T) {
	modules := []model.Module{
		{ID: "a/mod1.ts", Path: "a/mod1.ts"},
		{ID: "b/mod2.ts", Path: "b/mod2.ts"},
	}
	clusterOf := map[string]string{"a/mod1.ts": "cluster:a"}
	ApplyClusters(modules, clusterOf)

	if modules[0].Cluster == nil || *modules[0].Cluster != "cluster:a" {
		t.Errorf("modules[0].Cluster = %v, want \"cluster:a\"", modules[0].Cluster)
	}
	if modules[1].Cluster != nil {
		t.Errorf("modules[1].Cluster = %v, want nil", modules[1].Cluster)
	}
}
