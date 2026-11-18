package kg

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

var exportHTMLEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")

func escapeHtml(s string) string {
	return exportHTMLEscaper.Replace(s)
}

// exportTreeNode is one directory or file of the tree export.
type exportTreeNode struct {
	name     string
	children *OMap[string, *exportTreeNode]
	symbols  []string
}

// exportTreeTemplate is the template literal of the original, verbatim; its
// `${…}` placeholders are filled in order by exportFillTemplate.
const exportTreeTemplate = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(path.basename(root))} — graph tree</title>
<style>
body{background:#0d1117;color:#c9d1d9;font-family:ui-monospace,monospace;font-size:13px;margin:0;padding:20px}
h1{font-size:15px;color:#58a6ff} .node{margin-left:18px} .lbl{cursor:pointer;padding:1px 4px;border-radius:4px}
.lbl:hover{background:#161b22} .dir>.lbl{color:#58a6ff} .file>.lbl{color:#c9d1d9} .sym{color:#7ee787;margin-left:36px}
.count{color:#8b949e;font-size:11px;margin-left:6px} .hidden{display:none}
button{background:#161b22;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:4px 10px;cursor:pointer;margin-right:6px}
</style></head><body>
<h1>${escapeHtml(path.basename(root))} — module tree (${files.length} files)</h1>
<div><button id="expand">expand all</button><button id="collapse">collapse all</button></div>
<div id="tree"></div>
<script>
var DATA=${JSON.stringify(data)};
function count(n){var c=(n.symbols||[]).length;(n.children||[]).forEach(function(k){c+=1+count(k)});return c}
function render(n,el,depth){
  var d=document.createElement('div');d.className='node '+((n.children&&n.children.length)?'dir':'file');
  var l=document.createElement('div');l.className='lbl';l.textContent=(n.children&&n.children.length? '▸ ':'· ')+n.name;
  var c=document.createElement('span');c.className='count';c.textContent='('+count(n)+')';l.appendChild(c);
  d.appendChild(l);
  var kids=document.createElement('div');kids.className='kids'+(depth>1?' hidden':'');
  (n.children||[]).forEach(function(k){render(k,kids,depth+1)});
  (n.symbols||[]).forEach(function(s){var sd=document.createElement('div');sd.className='sym';sd.textContent=s;kids.appendChild(sd)});
  d.appendChild(kids);
  l.onclick=function(){kids.classList.toggle('hidden');l.textContent=(kids.classList.contains('hidden')?'▸ ':'▾ ')+n.name;l.appendChild(c)};
  el.appendChild(d);
}
render(DATA,document.getElementById('tree'),0);
document.getElementById('expand').onclick=function(){document.querySelectorAll('.kids').forEach(function(k){k.classList.remove('hidden')})};
document.getElementById('collapse').onclick=function(){document.querySelectorAll('.kids').forEach(function(k){k.classList.add('hidden')})};
</script></body></html>`

// exportFillTemplate replaces each placeholder once, left to right, without
// rescanning what it inserted.
func exportFillTemplate(tpl string, subs [][2]string) string {
	var sb strings.Builder
	rest := tpl
	for _, s := range subs {
		at := strings.Index(rest, s[0])
		if at < 0 {
			continue
		}
		sb.WriteString(rest[:at])
		sb.WriteString(s[1])
		rest = rest[at+len(s[0]):]
	}
	sb.WriteString(rest)
	return sb.String()
}

func exportTree(root string, graph *Graph, output string) (string, error) {
	// Hierarchy: directory → file → symbols, with descendant counts. Self-contained
	// vanilla-JS collapsible tree (offline parity with graphify's GRAPH_TREE.html).
	tree := &exportTreeNode{name: cmdBasename(root), children: newOMap[string, *exportTreeNode](), symbols: []string{}}
	byID := cmdByID(graph)
	fileSymbols := newOMap[string, *OSet[string]]()
	for _, e := range graph.Edges {
		if e.Relation != "contains" && e.Relation != "defines" && e.Relation != "method" {
			continue
		}
		src, tgt := byID[e.Source], byID[e.Target]
		if src == nil || tgt == nil || tgt.SourceFile == "" {
			continue
		}
		if !fileSymbols.Has(tgt.SourceFile) {
			fileSymbols.Set(tgt.SourceFile, newOSet[string]())
		}
		fileSymbols.G(tgt.SourceFile).Add(tgt.Label)
	}
	fileSet := newOSet[string]()
	for _, n := range graph.Nodes {
		if n.SourceFile != "" {
			fileSet.Add(n.SourceFile)
		}
	}
	files := fileSet.Items()
	sort.Strings(files)
	for _, rel := range files {
		cur := tree
		parts := strings.Split(rel, "/")
		for i := 0; i < len(parts)-1; i++ {
			if !cur.children.Has(parts[i]) {
				cur.children.Set(parts[i], &exportTreeNode{name: parts[i], children: newOMap[string, *exportTreeNode](), symbols: []string{}})
			}
			cur = cur.children.G(parts[i])
		}
		leafName := parts[len(parts)-1]
		if !cur.children.Has(leafName) {
			symbols := fileSymbols.G(rel).Items()
			sort.Strings(symbols)
			cur.children.Set(leafName, &exportTreeNode{name: leafName, children: newOMap[string, *exportTreeNode](), symbols: symbols})
		}
	}
	var toObj func(node *exportTreeNode) jsonValue
	toObj = func(node *exportTreeNode) jsonValue {
		kids := node.children.Values()
		sort.SliceStable(kids, func(i, j int) bool { return kids[i].name < kids[j].name })
		children := make(jvArr, 0, len(kids))
		for _, k := range kids {
			children = append(children, toObj(k))
		}
		return newJvObj().Set("name", jvStr(node.name)).Set("symbols", jvStrings(node.symbols)).Set("children", children)
	}
	data := toObj(tree)
	title := escapeHtml(cmdBasename(root))
	html := exportFillTemplate(exportTreeTemplate, [][2]string{
		{"${escapeHtml(path.basename(root))}", title},
		{"${escapeHtml(path.basename(root))}", title},
		{"${files.length}", strconv.Itoa(len(files))},
		{"${JSON.stringify(data)}", stringifyJSON(data, 0)},
	})
	p := output
	if p == "" {
		p = filepath.Join(outDir(root), "GRAPH_TREE.html")
	}
	if err := cmdWriteFile(p, html); err != nil {
		return "", err
	}
	return p, nil
}

// Wiki page file for a node, from its unique id: labels repeat (two `save()`
// methods would write, and link to, the same page). The `node-` prefix keeps
// pages clear of index.md and community-N.md; very long ids keep a readable
// prefix plus a hash.
func wikiPageName(id string) string {
	slug := strings.ReplaceAll(id, "_", "-")
	if cmdLenUTF16(slug) <= 120 {
		return "node-" + slug + ".md"
	}
	sum := sha1.Sum([]byte(id))
	return "node-" + cmdSliceUTF16(slug, 100) + "-" + hex.EncodeToString(sum[:])[:10] + ".md"
}

// exportConn is one `[arrow, neighbor id, edge]` triple of a god-node page.
type exportConn struct {
	arrow string
	nb    string
	e     *Edge
}

func exportWiki(root string, graph *Graph) (string, error) {
	dir := filepath.Join(outDir(root), "kg-wiki")
	if err := os.MkdirAll(dir, 0o777); err != nil {
		return "", err
	}
	adj := buildAdjacency(graph)
	byID := cmdByID(graph)
	gods := godNodes(graph, adj, 10)
	communities := graph.Communities
	idx := []string{"# Knowledge Graph Wiki", "", "_Generated by `draht-tools kg export wiki`._", "", "## Communities", ""}
	for _, c := range communities {
		if c.Size < 3 {
			continue
		}
		idx = append(idx, fmt.Sprintf("- [%s](community-%d.md) — %d nodes, cohesion %s", c.Name, c.ID, c.Size, jsNumber(c.Cohesion)))
	}
	idx = append(idx, "", "## God Nodes", "")
	for _, g := range gods {
		idx = append(idx, "- ["+g.Label+"]("+wikiPageName(g.ID)+") — degree "+cmdNum(g.Degree))
	}
	if err := cmdWriteFile(filepath.Join(dir, "index.md"), strings.Join(idx, "\n")+"\n"); err != nil {
		return "", err
	}

	for _, c := range communities {
		if c.Size < 3 {
			continue
		}
		L := []string{"# " + c.Name, "", fmt.Sprintf("Community %d · %d nodes · cohesion %s", c.ID, c.Size, jsNumber(c.Cohesion)), "", "## Key Concepts", ""}
		members := []*Node{}
		for _, id := range c.Members {
			if n := byID[id]; n != nil {
				members = append(members, n)
			}
		}
		sort.SliceStable(members, func(i, j int) bool {
			a, b := members[i], members[j]
			da, db := adj.deg.G(a.ID), adj.deg.G(b.ID)
			if da != db {
				return db < da
			}
			return a.ID < b.ID
		})
		for i, m := range members {
			if i >= 15 {
				break
			}
			sourceFile := m.SourceFile
			if sourceFile == "" {
				sourceFile = "external"
			}
			loc := ""
			if m.SourceLocation != "" {
				loc = ":" + m.SourceLocation
			}
			L = append(L, "- `"+m.Label+"` ("+sourceFile+loc+")")
		}
		L = append(L, "", "## Source Files", "")
		sourceSet := newOSet[string]()
		for _, m := range members {
			if m.SourceFile != "" {
				sourceSet.Add(m.SourceFile)
			}
		}
		sources := sourceSet.Items()
		sort.Strings(sources)
		if len(sources) > 20 {
			sources = sources[:20]
		}
		for _, f := range sources {
			L = append(L, "- "+f)
		}
		L = append(L, "", "## Connections by Relation", "")
		memberSet := make(map[string]bool, len(c.Members))
		for _, id := range c.Members {
			memberSet[id] = true
		}
		byRel := newOMap[string, []*Edge]()
		for _, e := range graph.Edges {
			if !memberSet[e.Source] && !memberSet[e.Target] {
				continue
			}
			if !byRel.Has(e.Relation) {
				byRel.Set(e.Relation, []*Edge{})
			}
			if es := byRel.G(e.Relation); len(es) < 10 {
				byRel.Set(e.Relation, append(es, e))
			}
		}
		// `[...byRel.entries()].sort()` compares the entries as strings:
		// the relation, then one ",[object Object]" per edge.
		rels := byRel.Keys()
		relKey := make(map[string]string, len(rels))
		for _, rel := range rels {
			relKey[rel] = rel + strings.Repeat(",[object Object]", len(byRel.G(rel)))
		}
		sort.SliceStable(rels, func(i, j int) bool { return relKey[rels[i]] < relKey[rels[j]] })
		for _, rel := range rels {
			L = append(L, "### "+rel, "")
			for _, e := range byRel.G(rel) {
				L = append(L, "- `"+cmdLabel(byID, e.Source)+"` → `"+cmdLabel(byID, e.Target)+"` ["+e.Confidence+"]")
			}
			L = append(L, "")
		}
		if err := cmdWriteFile(filepath.Join(dir, fmt.Sprintf("community-%d.md", c.ID)), strings.Join(L, "\n")+"\n"); err != nil {
			return "", err
		}
	}
	for _, g := range gods {
		L := []string{"# " + g.Label, "", "Degree " + cmdNum(g.Degree) + " · " + g.SourceFile, "", "## Relationships", ""}
		conns := []exportConn{}
		for _, e := range adj.out.G(g.ID) {
			conns = append(conns, exportConn{"→", e.Target, e})
		}
		for _, e := range adj.inn.G(g.ID) {
			conns = append(conns, exportConn{"←", e.Source, e})
		}
		sort.SliceStable(conns, func(i, j int) bool { return adj.deg.G(conns[j].nb) < adj.deg.G(conns[i].nb) })
		for i, c := range conns {
			if i >= 30 {
				break
			}
			L = append(L, "- "+c.arrow+" `"+cmdLabel(byID, c.nb)+"` ["+c.e.Relation+"] ["+c.e.Confidence+"]")
		}
		sourceFile := g.SourceFile
		if sourceFile == "" {
			sourceFile = "-"
		}
		L = append(L, "", "## Audit Trail", "", "Extraction: deterministic (draht-tools kg). Source: "+sourceFile+".")
		if err := cmdWriteFile(filepath.Join(dir, wikiPageName(g.ID)), strings.Join(L, "\n")+"\n"); err != nil {
			return "", err
		}
	}
	return dir, nil
}

func exportGraphml(root string, graph *Graph, output string) (string, error) {
	esc := escapeHtml
	L := []string{`<?xml version="1.0" encoding="UTF-8"?>`,
		`<graphml xmlns="http://graphml.graphdrawing.org/xmlns">`,
		`<key id="label" for="node" attr.name="label" attr.type="string"/>`,
		`<key id="source_file" for="node" attr.name="source_file" attr.type="string"/>`,
		`<key id="community" for="node" attr.name="community" attr.type="int"/>`,
		`<key id="relation" for="edge" attr.name="relation" attr.type="string"/>`,
		`<key id="confidence" for="edge" attr.name="confidence" attr.type="string"/>`,
		`<graph edgedefault="directed">`}
	for _, n := range graph.Nodes {
		community := -1
		if n.HasCommunity {
			community = n.Community
		}
		L = append(L, `<node id="`+esc(n.ID)+`"><data key="label">`+esc(n.Label)+`</data><data key="source_file">`+esc(n.SourceFile)+`</data><data key="community">`+strconv.Itoa(community)+`</data></node>`)
	}
	for _, e := range graph.Edges {
		L = append(L, `<edge source="`+esc(e.Source)+`" target="`+esc(e.Target)+`"><data key="relation">`+esc(e.Relation)+`</data><data key="confidence">`+esc(e.Confidence)+`</data></edge>`)
	}
	L = append(L, "</graph></graphml>")
	p := output
	if p == "" {
		p = filepath.Join(outDir(root), "graph.graphml")
	}
	if err := cmdWriteFile(p, strings.Join(L, "\n")); err != nil {
		return "", err
	}
	return p, nil
}
