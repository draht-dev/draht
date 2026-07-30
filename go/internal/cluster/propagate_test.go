package cluster

import "testing"

func TestPropagateLabels_MajorityVoteConverges(t *testing.T) {
	// A single outlier seeded "x" surrounded by three neighbours seeded
	// "y" should flip to "y" by majority vote.
	ids := []string{"n1", "n2", "n3", "n4"}
	adj := Adjacency{
		"n1": {"n2": {}, "n3": {}, "n4": {}},
		"n2": {"n1": {}},
		"n3": {"n1": {}},
		"n4": {"n1": {}},
	}
	seedOf := func(id string) string {
		if id == "n1" {
			return "x"
		}
		return "y"
	}
	label := PropagateLabels(ids, adj, map[string]struct{}{}, seedOf)
	if label["n1"] != "y" {
		t.Errorf("n1 label = %q, want \"y\" (outvoted by 3 \"y\" neighbours)", label["n1"])
	}
}

func TestPropagateLabels_HubVoteSuppressed(t *testing.T) {
	// n1 is the sole neighbour of a hub; the hub's label must never
	// influence n1 even though it is n1's only connection.
	ids := []string{"hub", "n1"}
	adj := Adjacency{
		"hub": {"n1": {}},
		"n1":  {"hub": {}},
	}
	hubs := map[string]struct{}{"hub": {}}
	seedOf := func(id string) string {
		if id == "hub" {
			return "hub-label"
		}
		return "leaf-label"
	}
	label := PropagateLabels(ids, adj, hubs, seedOf)
	if label["n1"] != "leaf-label" {
		t.Errorf("n1 label = %q, want \"leaf-label\" (hub must not broadcast)", label["n1"])
	}
}

func TestPropagateLabels_TieBreaksLexicographically(t *testing.T) {
	// n1 has two neighbours with equally-frequent, different labels; the
	// lexicographically smaller one must win.
	ids := []string{"n1", "n2", "n3"}
	adj := Adjacency{
		"n1": {"n2": {}, "n3": {}},
		"n2": {"n1": {}},
		"n3": {"n1": {}},
	}
	seedOf := func(id string) string {
		switch id {
		case "n1":
			return "start"
		case "n2":
			return "zzz"
		default:
			return "aaa"
		}
	}
	label := PropagateLabels(ids, adj, map[string]struct{}{}, seedOf)
	if label["n1"] != "aaa" {
		t.Errorf("n1 label = %q, want \"aaa\" (lexicographically smaller of a 1-1 tie)", label["n1"])
	}
}

func TestPropagateLabels_NoNeighboursKeepsSeed(t *testing.T) {
	ids := []string{"isolated"}
	adj := Adjacency{}
	label := PropagateLabels(ids, adj, map[string]struct{}{}, func(string) string { return "seed" })
	if label["isolated"] != "seed" {
		t.Errorf("isolated label = %q, want \"seed\"", label["isolated"])
	}
}
