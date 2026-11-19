package kg

import (
	"math"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// textStat is the word statistics of one file's text, for `kg query`.
type textStat struct {
	node  *Node
	tf    *OMap[string, int]
	count int
}

// parsedFile is one file read and parsed (phase 1), before any graph state.
type parsedFile struct {
	rel    string
	lang   string
	tf     *OMap[string, int] // words of the text (see fileWords)
	count  int
	lineOf func(int) int
	decls  *Decls
	ok     bool
}

// fileWords counts the words of a file's text (comments and strings
// included): the tokens of /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g that are at
// least three characters long, lowercased.
func fileWords(content []rune) (*OMap[string, int], int) {
	tf := newOMap[string, int]()
	count := 0
	isUpper := func(c rune) bool { return c >= 'A' && c <= 'Z' }
	isLower := func(c rune) bool { return c >= 'a' && c <= 'z' }
	isDigit := func(c rune) bool { return c >= '0' && c <= '9' }
	n := len(content)
	buf := make([]byte, 0, 64)
	for i := 0; i < n; {
		c := content[i]
		start, end := i, i
		switch {
		case isUpper(c):
			j := i
			for j < n && isUpper(content[j]) {
				j++
			}
			if j < n && isLower(content[j]) {
				if j-i >= 2 {
					end = j - 1 // the last capital starts the next word
				} else {
					end = j
					for end < n && isLower(content[end]) {
						end++
					}
				}
			} else {
				end = j
			}
		case isLower(c):
			end = i
			for end < n && isLower(content[end]) {
				end++
			}
		case isDigit(c):
			end = i
			for end < n && isDigit(content[end]) {
				end++
			}
		default:
			i++
			continue
		}
		i = end
		if end-start < 3 {
			continue
		}
		buf = buf[:0]
		for k := start; k < end; k++ {
			ch := content[k]
			if isUpper(ch) {
				ch += 'a' - 'A'
			}
			buf = append(buf, byte(ch))
		}
		t := string(buf)
		tf.Set(t, tf.G(t)+1)
		count++
	}
	return tf, count
}

// jsLength is `s.length` of the text: UTF-16 code units.
func jsLength(t []rune) int {
	n := len(t)
	for _, c := range t {
		if c > 0xffff {
			n++
		}
	}
	return n
}

// parseFiles reads and parses every file (phase 1). Files are independent, so
// they are parsed concurrently; the result keeps the walk order.
func parseFiles(root string, files []string) []parsedFile {
	out := make([]parsedFile, len(files))
	workers := runtime.GOMAXPROCS(0)
	if workers > len(files) {
		workers = len(files)
	}
	var wg sync.WaitGroup
	next := make(chan int)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range next {
				abs := files[i]
				relOS, err := filepath.Rel(root, abs)
				if err != nil {
					continue
				}
				rel := filepath.ToSlash(relOS)
				lang := kgLangByExt[strings.ToLower(jsExtname(rel))]
				raw, err := os.ReadFile(abs)
				if err != nil {
					continue
				}
				content := []rune(string(raw))
				if jsLength(content) > 2_000_000 {
					continue
				}
				decls := parseDecls(rel, content, lang)
				if lang != "go" {
					decls.Masked = nil // only the Go import scan reads it after parsing
				}
				tf, count := fileWords(content)
				out[i] = parsedFile{rel: rel, lang: lang, decls: decls, tf: tf, count: count, lineOf: lineIndex(content), ok: true}
			}
		}()
	}
	for i := range files {
		next <- i
	}
	close(next)
	wg.Wait()
	return out
}

// buildGraph builds the graph of the repository at root (phases 1-8).
func buildGraph(root string) *Graph {
	files := walk(root)
	b := &builder{
		root:         root,
		nodeByID:     map[string]*Node{},
		perFile:      newOMap[string, *fileInfo](),
		classMembers: newOMap[string, *OMap[string, string]](),
		baseOf:       newOMap[string, []string](),
	}
	textStats := newOMap[string, *textStat]()

	// -- phase 1+2: decls → nodes, contains/defines/method edges
	for _, p := range parseFiles(root, files) {
		if !p.ok {
			continue
		}
		rel, lang, decls := p.rel, p.lang, p.decls
		for _, c := range decls.Classes {
			if c.MethodsOverLimit != 0 {
				b.methodLimitHits = append(b.methodLimitHits, MethodLimitHit{File: rel, Name: c.Name, Declared: len(c.Methods) + c.MethodsOverLimit})
			}
		}
		fileNid := fileNodeID(rel)
		fileNode := b.addNode(codeNode(fileNid, path.Base(rel), rel, 1))
		if decls.Docstring != "" {
			fileNode.Rationale = decls.Docstring
		}
		// words of the file's text (comments and strings included), for `kg query`
		if fileNode.SourceFile == rel && !textStats.Has(rel) {
			textStats.Set(rel, &textStat{node: fileNode, tf: p.tf, count: p.count})
		}
		localDefs := newOMap[string, string]()
		names := make([]string, 0, len(decls.Classes)+len(decls.Functions)+len(decls.Types))
		for _, c := range decls.Classes {
			names = append(names, c.Name)
		}
		for _, f := range decls.Functions {
			names = append(names, f.Name)
		}
		for _, t := range decls.Types {
			names = append(names, t.Name)
		}
		symIDs := fileSymbolIDs(rel, names, lang)

		for _, c := range decls.Classes {
			nid := symIDs.G(c.Name)
			n := codeNode(nid, c.Name, rel, c.Line)
			if c.Kind != "" && c.Kind != "struct" {
				n.Type = c.Kind
			} else {
				n.Type = "class"
			}
			b.addNode(n)
			b.addEdge(fileNid, nid, "contains", edgeOpts{File: rel, Line: c.Line})
			localDefs.Set(c.Name, nid)
			c.MethodIds = methodNodeIDs(rel, c.Name, c.Methods, lang)
			if len(c.Methods) > 0 {
				b.classMembers.Set(nid, c.MethodIds)
			}
			for _, meth := range c.Methods {
				mid := c.MethodIds.G(meth.Name)
				mn := codeNode(mid, meth.Name+"()", rel, meth.Line)
				mn.Callable = true
				b.addNode(mn)
				b.addEdge(nid, mid, "method", edgeOpts{File: rel, Line: meth.Line})
			}
		}
		for _, f := range decls.Functions {
			if localDefs.Has(f.Name) {
				continue
			}
			nid := symIDs.G(f.Name)
			n := codeNode(nid, f.Name+"()", rel, f.Line)
			n.Callable = true
			b.addNode(n)
			b.addEdge(fileNid, nid, "defines", edgeOpts{File: rel, Line: f.Line})
			localDefs.Set(f.Name, nid)
		}
		for _, t := range decls.Types {
			if localDefs.Has(t.Name) {
				continue
			}
			nid := symIDs.G(t.Name)
			n := codeNode(nid, t.Name, rel, t.Line)
			n.Type = t.Kind
			b.addNode(n)
			b.addEdge(fileNid, nid, "defines", edgeOpts{File: rel, Line: t.Line})
			localDefs.Set(t.Name, nid)
		}
		// The file's default binding: `export default function original()` is
		// imported under ANY local name (`import renamed from …`), so default
		// imports must resolve through this, never through the importer's name.
		defaultNid := ""
		for _, c := range decls.Classes {
			if c.IsDefault && localDefs.Has(c.Name) {
				defaultNid = localDefs.G(c.Name)
			}
		}
		for _, f := range decls.Functions {
			if f.IsDefault && localDefs.Has(f.Name) {
				defaultNid = localDefs.G(f.Name)
			}
		}
		if defaultNid == "" && decls.DefaultName != "" && localDefs.Has(decls.DefaultName) {
			defaultNid = localDefs.G(decls.DefaultName)
		}
		// Declarations below top level (inside function bodies and callbacks):
		// one node each under the declaration that holds them, repeats numbered.
		if len(decls.Nested) > 0 {
			type holder struct {
				nid  string
				line int
				end  int
			}
			var holders []holder
			for _, c := range decls.Classes {
				holders = append(holders, holder{localDefs.G(c.Name), c.Line, c.End})
				for _, meth := range c.Methods {
					holders = append(holders, holder{c.MethodIds.G(meth.Name), meth.Line, meth.End})
				}
			}
			for _, f := range decls.Functions {
				holders = append(holders, holder{localDefs.G(f.Name), f.Line, f.End})
			}
			sort.SliceStable(holders, func(i, j int) bool { return holders[i].line < holders[j].line })
			used := map[string]int{}
			for _, nd := range decls.Nested {
				parent := fileNid
				for _, h := range holders {
					if h.line > nd.Line {
						break
					}
					if h.nid != "" && h.end != 0 && nd.Line <= h.end {
						parent = h.nid
					}
				}
				base := makeID(parent, nd.Name)
				seen := used[base] + 1
				used[base] = seen
				nid := base
				if !(seen == 1 && !b.hasNode(base)) {
					nid = makeID(base, strconv.Itoa(seen))
				}
				if b.hasNode(nid) {
					continue
				}
				if nd.Kind == "function" {
					n := codeNode(nid, nd.Name+"()", rel, nd.Line)
					n.Callable = true
					b.addNode(n)
				} else {
					n := codeNode(nid, nd.Name, rel, nd.Line)
					n.Type = nd.Kind
					b.addNode(n)
				}
				b.addEdge(parent, nid, "contains", edgeOpts{File: rel, Line: nd.Line})
			}
		}
		b.perFile.Set(rel, &fileInfo{
			Rel: rel, Lang: lang, Decls: decls, Stripped: decls.CallText, LocalDefs: localDefs, DefaultNid: defaultNid,
			ImportedNames: newOMap[string, *importedName](), FileNid: fileNid, LineOf: p.lineOf,
		})
	}

	b.buildGo()
	b.buildRust()
	b.initResolver()
	b.importEdges()
	b.heritageEdges()
	b.indexMethods()

	// -- phase 5: calls / instantiates / indirect_call
	for _, rel := range b.res.rels {
		pf := b.perFile.G(rel)
		switch pf.Lang {
		case "go":
			b.goCalls(rel, pf)
		case "rust":
			b.rustCalls(rel, pf)
		default:
			b.scriptCalls(rel, pf)
		}
	}

	// -- file keywords: each file's most distinctive words
	{
		df := map[string]int{}
		for _, st := range textStats.All() {
			for t := range st.tf.All() {
				df[t]++
			}
		}
		n := float64(textStats.Len())
		if textStats.Len() == 0 {
			n = 1
		}
		idfOf := func(t string) float64 {
			d := float64(df[t])
			return math.Log(1 + (n-d+0.5)/(d+0.5))
		}
		for _, st := range textStats.All() {
			if st.count == 0 {
				continue
			}
			st.node.Terms = fileKeywords(st.tf, idfOf)
			st.node.Tokens = st.count
		}
	}

	// -- phase 6: dedupe + sort (determinism)
	edgeKey := func(e *Edge) string { return e.Source + " " + e.Target + " " + e.Relation }
	seenEdge := make(map[string]bool, len(b.edges))
	deduped := make([]*Edge, 0, len(b.edges))
	keys := make(map[*Edge]string, len(b.edges))
	for _, e := range b.edges {
		k := edgeKey(e)
		if seenEdge[k] {
			continue
		}
		if !b.hasNode(e.Source) || !b.hasNode(e.Target) {
			continue
		}
		seenEdge[k] = true
		keys[e] = k
		deduped = append(deduped, e)
	}
	nodes := b.nodes
	sort.SliceStable(nodes, func(i, j int) bool { return nodes[i].ID < nodes[j].ID })
	sort.SliceStable(deduped, func(i, j int) bool { return keys[deduped[i]] < keys[deduped[j]] })

	// -- phase 7: communities + analysis
	communityOf, communities := computeCommunities(nodes, deduped)
	for _, n := range nodes {
		if idx, ok := communityOf[n.ID]; ok {
			n.Community = idx
			n.HasCommunity = true
			if idx >= 0 && idx < len(communities) {
				n.CommunityName = communities[idx].Name
			}
		}
		n.NormLabel = strings.ReplaceAll(normalizeID(n.Label), "_", " ")
	}

	return &Graph{Nodes: nodes, Edges: deduped, Communities: communities, IDCollisions: b.idCollisions, MethodLimitHits: b.methodLimitHits}
}

// importEdges is phase 3: import edges and the names each file binds.
func (b *builder) importEdges() {
	rels := b.res.rels
	// Directory names and module stems the repo itself provides: a top-level
	// package the repo defines (a `src/` layout the root-relative resolver
	// misses) is not proof of an external import.
	repoNames := map[string]bool{}
	for _, rel := range rels {
		for _, part := range strings.Split(rel, "/") {
			repoNames[reDotExt.ReplaceFirstLit(part, "")] = true
		}
	}
	for _, rel := range rels {
		pf := b.perFile.G(rel)
		if pf.Lang == "rust" {
			b.rustImports(rel, pf)
			continue
		}
		for _, imp := range pf.Decls.Imports {
			if pf.Lang == "go" && b.goImportEdges(rel, pf, imp) {
				continue
			}
			bind := pf.ImportedNames
			if pf.Lang == "python" {
				if region := pyDefRegion(pf, imp.Line); region != nil {
					bind = newOMap[string, *importedName]()
					pf.ScopedImports = append(pf.ScopedImports, &scopedImport{Start: region.start, End: region.end, Map: bind})
				}
			}
			resolved := b.resolveSpec(rel, imp.Spec)
			var targetFileNid string
			if resolved != "" {
				targetFileNid = b.perFile.G(resolved).FileNid
			} else {
				// external module node (concept-style: no source_file, like graphify module nodes)
				targetFileNid = makeID(imp.Spec)
				if targetFileNid == "" {
					continue
				}
				// `models` (or `.models`) must not merge with the repo's own models.py.
				if taken, ok := b.nodeByID[targetFileNid]; ok && taken.SourceFile != "" {
					targetFileNid = makeID("external", imp.Spec)
				}
				b.addNode(&Node{ID: targetFileNid, Label: imp.Spec, FileType: "code", Type: "module"})
				// Names imported from a package outside the repo stay with that
				// import: they never fall back to a same-named repo symbol.
				if !strings.HasPrefix(imp.Spec, ".") && !imp.Dynamic && !repoNames[specHead(imp.Spec)] {
					for _, n := range imp.Names {
						bind.Set(n.Local, &importedName{Name: n.Imported, External: true})
					}
					if imp.Default != "" {
						bind.Set(imp.Default, &importedName{Name: "default", External: true})
					}
					if imp.Namespace != "" && imp.Namespace != "*" && !imp.ReExport {
						bind.Set(imp.Namespace, &importedName{Name: "*", External: true})
					}
				}
			}
			relation := "imports_from"
			if imp.Dynamic {
				relation = "dynamic_import"
			} else if imp.ReExport {
				relation = "re_exports"
			}
			// Python: `from pkg import mod` imports the submodule, `from m import *`
			// brings every name of m into scope.
			names := imp.Names
			if pf.Lang == "python" && resolved != "" && len(names) > 0 {
				var rest []ImportName
				for _, n := range names {
					if n.Imported == "*" {
						pf.StarImports = append(pf.StarImports, resolved)
						continue
					}
					sub := ""
					if strings.HasSuffix(resolved, "/__init__.py") || resolved == "__init__.py" {
						sub = b.probePyModule(nodeJoin(path.Dir(resolved), n.Imported))
					}
					if sub != "" && !b.perFile.G(resolved).LocalDefs.Has(n.Imported) {
						b.addEdge(pf.FileNid, b.perFile.G(sub).FileNid, relation, edgeOpts{File: rel, Line: imp.Line, Context: "import"})
						bind.Set(n.Local, &importedName{Rel: sub, Name: "*"})
					} else {
						rest = append(rest, n)
					}
				}
				if len(rest) == 0 {
					someNamed := false
					for _, n := range names {
						if n.Imported != "*" {
							someNamed = true
							break
						}
					}
					if someNamed {
						continue
					}
				}
				names = rest
			}
			b.addEdge(pf.FileNid, targetFileNid, relation, edgeOpts{File: rel, Line: imp.Line, Context: "import", Deferred: imp.Dynamic})
			// symbol-level imports edges (only when target resolves in-repo)
			if resolved != "" && !imp.Dynamic {
				tpf := b.perFile.G(resolved)
				for _, n := range names {
					tnid := tpf.LocalDefs.G(n.Imported)
					if tnid == "" {
						tnid = b.resolveExported(resolved, n.Imported)
					}
					if tnid != "" {
						if !imp.ReExport {
							b.addEdge(pf.FileNid, tnid, "imports", edgeOpts{File: rel, Line: imp.Line, Context: "import"})
						}
						bind.Set(n.Local, &importedName{Rel: resolved, Name: n.Imported, Nid: tnid})
					} else {
						bind.Set(n.Local, &importedName{Rel: resolved, Name: n.Imported})
					}
				}
				if imp.Default != "" {
					bind.Set(imp.Default, &importedName{Rel: resolved, Name: "default", Nid: b.defaultOf(resolved)})
				}
				// `export * as ns from` binds `ns` for importers of this module, not here.
				if imp.Namespace != "" && imp.Namespace != "*" && !imp.ReExport {
					bind.Set(imp.Namespace, &importedName{Rel: resolved, Name: "*", Cjs: imp.Cjs})
				}
			}
		}
	}
}

// specHead is `spec.split(/[./]/)[0]`.
func specHead(spec string) string {
	if i := strings.IndexAny(spec, "./"); i >= 0 {
		return spec[:i]
	}
	return spec
}

// resolved is what a name refers to: { nid, confidence }.
type resolvedName struct {
	nid        string
	confidence string
}

// resolveName: local → import evidence → a star import → nil. A name nothing
// in the file accounts for is not guessed from the rest of the repo. line 0
// means "no line".
func (b *builder) resolveName(pf *fileInfo, name string, line int) *resolvedName {
	var scoped *importedName
	if line != 0 && len(pf.ScopedImports) > 0 {
		scoped = importedAt(pf, name, line)
	}
	if pf.LocalDefs.Has(name) && (scoped == nil || scoped == pf.ImportedNames.G(name)) {
		return &resolvedName{nid: pf.LocalDefs.G(name), confidence: "EXTRACTED"}
	}
	imp := scoped
	if imp == nil {
		imp = pf.ImportedNames.G(name)
	}
	if imp != nil && imp.Nid != "" {
		return &resolvedName{nid: imp.Nid, confidence: "EXTRACTED"}
	}
	if imp != nil && imp.External {
		return nil
	}
	if imp != nil && imp.Rel != "" {
		tpf, ok := b.perFile.Get(imp.Rel)
		// A default import binds to the TARGET's default declaration,
		// whatever local name the importer chose.
		t := ""
		if imp.Name == "default" {
			t = b.defaultOf(imp.Rel)
		} else if ok {
			t = tpf.LocalDefs.G(imp.Name)
			if t == "" {
				t = b.resolveExported(imp.Rel, imp.Name)
			}
		}
		if t != "" {
			return &resolvedName{nid: t, confidence: "EXTRACTED"}
		}
		return nil
	}
	for _, star := range pf.StarImports {
		if t := b.resolveExported(star, name); t != "" {
			return &resolvedName{nid: t, confidence: "EXTRACTED"}
		}
	}
	return nil
}

// heritageEdges is phase 4: inherits / implements / extends.
func (b *builder) heritageEdges() {
	scoreOf := func(r *resolvedName) (float64, bool) {
		if r.confidence == "INFERRED" {
			return inferredCallScore, true
		}
		return 0, false
	}
	addBase := func(cnid, base string) {
		b.baseOf.Set(cnid, append(b.baseOf.G(cnid), base))
	}
	for _, rel := range b.res.rels {
		pf := b.perFile.G(rel)
		for _, c := range pf.Decls.Classes {
			cnid := pf.LocalDefs.G(c.Name)
			if cnid == "" {
				continue
			}
			for _, base := range c.Bases {
				var r *resolvedName
				if base.Module != "" {
					ns := pf.ImportedNames.G(base.Module)
					t := ""
					if ns != nil && ns.Name == "*" && ns.Rel != "" {
						t = b.perFile.G(ns.Rel).LocalDefs.G(base.Name)
						if t == "" {
							t = b.resolveExported(ns.Rel, base.Name)
						}
					}
					if t != "" {
						r = &resolvedName{nid: t, confidence: "EXTRACTED"}
					}
				} else if !builtinNoiseLabels[base.Name] {
					r = b.resolveName(pf, base.Name, 0)
				}
				if r != nil && r.nid != cnid {
					if n, ok := b.nodeByID[r.nid]; ok && n.Type == "class" {
						b.addEdge(cnid, r.nid, "inherits", edgeOpts{File: rel, Line: c.Line, Confidence: r.confidence})
						addBase(cnid, r.nid)
					}
				}
			}
			if c.Extends != "" && !builtinNoiseLabels[c.Extends] {
				if r := b.resolveName(pf, c.Extends, 0); r != nil {
					score, has := scoreOf(r)
					b.addEdge(cnid, r.nid, "inherits", edgeOpts{File: rel, Line: c.Line, Confidence: r.confidence, Score: score, HasScore: has})
					addBase(cnid, r.nid)
				}
			}
			for _, iface := range c.Implements {
				if builtinNoiseLabels[iface] {
					continue
				}
				if r := b.resolveName(pf, iface, 0); r != nil {
					score, has := scoreOf(r)
					b.addEdge(cnid, r.nid, "implements", edgeOpts{File: rel, Line: c.Line, Confidence: r.confidence, Score: score, HasScore: has})
				}
			}
		}
		for _, t := range pf.Decls.Types {
			if !pf.LocalDefs.Has(t.Name) {
				continue
			}
			bases := t.ExtendsAll
			if bases == nil && t.Extends != "" {
				bases = []string{t.Extends}
			}
			for _, base := range bases {
				if r := b.resolveName(pf, base, 0); r != nil && r.nid != pf.LocalDefs.G(t.Name) {
					b.addEdge(pf.LocalDefs.G(t.Name), r.nid, "extends", edgeOpts{File: rel, Line: t.Line, Confidence: r.confidence})
				}
			}
		}
	}
}

// memberOf: a member of a class: its own, or the nearest base class's (`from`
// skips the class itself).
func (b *builder) memberOf(classNid, name string, from, depth int) string {
	if classNid == "" || depth > 5 {
		return ""
	}
	if depth >= from {
		if own, ok := b.classMembers.Get(classNid); ok && own.Has(name) {
			return own.G(name)
		}
	}
	for _, base := range b.baseOf.G(classNid) {
		if hit := b.memberOf(base, name, 0, depth+1); hit != "" {
			return hit
		}
	}
	return ""
}

// indexMethods: method names one class of the repo declares and no other, per
// language family: what a call on a receiver of unknown type most plausibly
// reaches. Names the language's own objects answer to are never guessed.
func (b *builder) indexMethods() {
	b.methodsByName = map[string]map[string]*OSet[string]{}
	for classNid, members := range b.classMembers.All() {
		node := b.nodeByID[classNid]
		if node == nil || node.SourceFile == "" {
			continue
		}
		lang := b.perFile.G(node.SourceFile).Lang
		if lang == "" {
			continue
		}
		family := langFamily[lang]
		table := b.methodsByName[family]
		if table == nil {
			table = map[string]*OSet[string]{}
			b.methodsByName[family] = table
		}
		for name, mid := range members.All() {
			set := table[name]
			if set == nil {
				set = newOSet[string]()
				table[name] = set
			}
			set.Add(mid)
		}
	}
}

func (b *builder) uniqueMethod(lang, name string) string {
	if jsLength([]rune(name)) < 4 || commonMethodNames[name] {
		return ""
	}
	table := b.methodsByName[langFamily[lang]]
	if table == nil {
		return ""
	}
	if set := table[name]; set != nil && set.Len() == 1 {
		return set.Items()[0]
	}
	return ""
}
