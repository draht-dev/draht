package kg

import (
	"sort"
	"strings"
)

// Phase 5 for TypeScript / JavaScript and Python: calls, instantiates,
// indirect_call. (Go and Rust have their own binders: goCalls, rustCalls.)

var (
	reCallParam      = mustRE(`^\s*(?:\*{1,2}|\.\.\.)?(?:(?:public|private|protected|readonly|override)\s+)*([A-Za-z_$][\w$]*)\??\s*(?::\s*["']?([A-Za-z_$][\w$.]*))?`, "")
	reCallIdent      = mustRE(`[A-Za-z_$][\w$]*`, "")
	reCallPyAssign   = mustRE(`^\s+([A-Za-z_]\w*)\s*(?::\s*([A-Za-z_][\w.]*))?[^=\n]*=(?!=)\s*(?:([A-Za-z_][\w.]*)\s*\()?`, "")
	reCallPyFor      = mustRE(`^\s+(?:async\s+)?for\s+([^:]*?)\s+in\b`, "")
	reCallPyIdent    = mustRE(`[A-Za-z_]\w*`, "")
	reCallPyAs       = mustRE(`\bas\s+([A-Za-z_]\w*)`, "")
	reCallDecl       = mustRE(`\b(?:const|let|var)\s+(?:([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$.]*)[^=;]*)?(?:=\s*(?:await\s+)?(?:new\s+([A-Za-z_$][\w$.]*))?)?|[[{]([^=]*?)[\]}]\s*=)`, "")
	reCallDestruct   = mustRE(`(?:[A-Za-z_$][\w$]*\s*:\s*)?([A-Za-z_$][\w$]*)`, "")
	reCallArrowList  = mustRE(`\(([^()]*)\)\s*(?::[^=;{]+)?=>`, "")
	reCallArrowParam = mustRE(`(?<![\w$.:])([A-Za-z_$][\w$]*)\??\s*(?::\s*([A-Za-z_$][\w$.]*))?`, "")
	reCallArrowOne   = mustRE(`(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>`, "")
	reCallCatch      = mustRE(`\bcatch\s*\(\s*([A-Za-z_$][\w$]*)`, "")
	reCallFuncParams = mustRE(`\bfunction\s*\*?\s*[A-Za-z_$][\w$]*\s*\(([^)]*)\)`, "")
	reCallFuncParam  = mustRE(`(?<![\w$.:])([A-Za-z_$][\w$]*)`, "")
	reCallPyField    = mustRE(`\bself\.([A-Za-z_]\w*)\s*(?::\s*["']?([A-Za-z_][\w.]*))?[^=\n]*=(?!=)\s*(?:([A-Za-z_][\w.]*)\s*\()?`, "")
	reCallTsField    = mustRE(`\b(?:public|private|protected|readonly)\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:\s*([A-Za-z_$][\w$.]*)`, "")
	reCallThisNew    = mustRE(`\bthis\.(#?[A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$.]*)`, "")
	reCallCall       = mustRE(`(?<![\w.$#])([A-Za-z_$][\w$]*)\s*\(`, "")
	reCallNew        = mustRE(`\bnew\s+([A-Za-z_$][\w$.]*)\s*[(<]`, "")
	reCallSelf       = mustRE(`\b(?:this|self)\.(#?[A-Za-z_$][\w$]*)\s*\(`, "")
	reCallNs         = mustRE(`(?<![\w.$#])((?:[A-Za-z_$][\w$]*\.)+)([A-Za-z_$][\w$]*)\s*\(`, "")
	reCallArg        = mustRE(`[(,]\s*([A-Za-z_$][\w$]*)\s*(?=[,)])`, "")
)

// callAnchor is one symbol region of a file: decl line → tracked body end.
type callAnchor struct {
	nid       string
	line      int
	decl      int
	headerEnd int // 0: not set (a class)
	end       int // 0: open-ended
	isClass   bool
	cls       *Class
	classNid  string
}

// regionNames is what a function binds itself: its locals and their types.
type regionNames struct {
	locals map[string]bool
	types  map[string]string
}

func firstSeg(s string) string {
	if i := strings.IndexByte(s, '.'); i >= 0 {
		return s[:i]
	}
	return s
}

// indentOf is the width of a line's leading blanks, a tab counting four.
func indentOf(t []rune) int {
	n := 0
	for _, c := range t {
		if c == ' ' {
			n++
		} else if c == '\t' {
			n += 4
		} else {
			break
		}
	}
	return n
}

func (b *builder) scriptCalls(rel string, pf *fileInfo) {
	lines := splitLines(pf.Stripped)
	lineAt := func(l int) []rune { // lines[l - 1] || ""
		if l < 1 || l > len(lines) {
			return nil
		}
		return lines[l-1]
	}
	// symbol regions: decl line → tracked body end (brace depth), falling
	// back to open-ended (next-anchor semantics) where no end was tracked.
	// A top-level call AFTER a function's closing brace belongs to the
	// file, not to that function.
	var anchors []*callAnchor
	startOr := func(start, line int) int {
		if start != 0 {
			return start
		}
		return line
	}
	headerEndOf := func(f *Func) int {
		if f.BodyStart > 0 {
			return pf.LineOf(f.BodyStart)
		}
		return f.Line
	}
	for _, c := range pf.Decls.Classes {
		classNid := pf.LocalDefs.G(c.Name)
		for _, meth := range c.Methods {
			anchors = append(anchors, &callAnchor{nid: c.MethodIds.G(meth.Name), line: startOr(meth.Start, meth.Line), decl: meth.Line, headerEnd: headerEndOf(meth), end: meth.End, cls: c, classNid: classNid})
		}
		anchors = append(anchors, &callAnchor{nid: classNid, line: startOr(c.Start, c.Line), decl: c.Line, end: c.End, isClass: true, cls: c, classNid: classNid})
	}
	for _, f := range pf.Decls.Functions {
		anchors = append(anchors, &callAnchor{nid: pf.LocalDefs.G(f.Name), line: startOr(f.Start, f.Line), decl: f.Line, headerEnd: headerEndOf(f), end: f.End})
	}
	sort.SliceStable(anchors, func(i, j int) bool { return anchors[i].line < anchors[j].line })
	regionAt := func(lineNo int) *callAnchor {
		var cur *callAnchor
		for _, a := range anchors {
			if a.line > lineNo {
				break
			}
			if a.end == 0 || lineNo <= a.end {
				cur = a
			}
		}
		return cur
	}
	regionOf := func(lineNo int) string {
		if a := regionAt(lineNo); a != nil {
			return a.nid
		}
		return pf.FileNid
	}
	// Names a function binds itself (parameters, local declarations) and the
	// class types written or constructed for them. A local name shadows a
	// file-level or imported one; a typed one says which class `x.method()`
	// is called on.
	py := pf.Lang == "python"
	regionInfo := map[*callAnchor]*regionNames{}
	infoOf := func(a *callAnchor) *regionNames {
		if info, ok := regionInfo[a]; ok {
			return info
		}
		info := &regionNames{locals: map[string]bool{}, types: map[string]string{}}
		regionInfo[a] = info
		if a.end == 0 || a.isClass {
			return info
		}
		note := func(name, typ string) {
			if name == "" {
				return
			}
			info.locals[name] = true
			if typ != "" {
				if _, has := info.types[name]; !has {
					info.types[name] = typ
				}
			}
		}
		hdrOr := a.headerEnd // a.headerEnd || a.decl
		if hdrOr == 0 {
			hdrOr = a.decl
		}
		// parameters: the first parenthesised list of the header
		headerEnd := a.decl
		{
			var text []rune
			open, closeAt := -1, -1
			for l := a.decl; l <= a.end && l < a.decl+60; l++ {
				text = append(text, lineAt(l)...)
				text = append(text, '\n')
				if open < 0 {
					open = indexRune(text, '(', 0)
				}
				if open >= 0 {
					closeAt = matchClose(text, open)
				}
				headerEnd = l
				if closeAt >= 0 || (open < 0 && l >= hdrOr) {
					break
				}
			}
			if open >= 0 && closeAt > open {
				for _, piece := range splitTopLevel(sub(text, open+1, closeAt)) {
					if pm := reCallParam.Find(piece); pm != nil {
						note(pm.S(1), pm.S(2))
					} else { // a destructured parameter
						head := firstOf(firstOf(string(piece), "="), ":")
						for id := range reCallIdent.IterS(head) {
							note(id.S(0), "")
						}
					}
				}
			}
			if headerEnd < hdrOr {
				headerEnd = hdrOr
			}
			if headerEnd > a.end {
				headerEnd = a.end
			}
		}
		from := a.decl
		if py {
			from = headerEnd + 1
		}
		for l := from; l <= a.end; l++ {
			ln := lineAt(l)
			if py {
				if m := reCallPyAssign.Find(ln); m != nil {
					t := m.S(2)
					if t == "" {
						t = m.S(3)
					}
					note(m.S(1), t)
				} else if m := reCallPyFor.Find(ln); m != nil {
					for id := range reCallPyIdent.Iter(m.R(1), 0) {
						note(id.S(0), "")
					}
				}
				for w := range reCallPyAs.Iter(ln, 0) {
					note(w.S(1), "")
				}
			} else {
				for m := range reCallDecl.Iter(ln, fromIfAny(ln, "const", "let", "var")) {
					if m.S(1) != "" {
						t := m.S(2)
						if t == "" {
							t = m.S(3)
						}
						note(m.S(1), t)
					} else {
						for id := range reCallDestruct.Iter(m.R(4), 0) {
							note(id.S(1), "")
						}
					}
				}
				for w := range reCallArrowList.Iter(ln, fromIfAny(ln, "=>")) {
					for id := range reCallArrowParam.Iter(w.R(1), 0) {
						note(id.S(1), id.S(2))
					}
				}
				for w := range reCallArrowOne.Iter(ln, fromIfAny(ln, "=>")) {
					note(w.S(1), "")
				}
				if m := reCallCatch.Find(ln); m != nil {
					note(m.S(1), "")
				}
				for w := range reCallFuncParams.Iter(ln, fromIfAny(ln, "function")) {
					for id := range reCallFuncParam.Iter(w.R(1), 0) {
						note(id.S(1), "")
					}
				}
			}
		}
		return info
	}
	// Outside every indexed declaration (a callback, a function assigned to a
	// property): `name` declared with var/let/const in a block that encloses
	// `lineNo`, found by walking outward through less-indented lines.
	indents := make([]int, len(lines)) // 0: not computed yet; 1: blank line; else indent + 2
	lineIndent := func(l int) int {    // -1 for a blank or missing line
		if l < 1 || l > len(lines) {
			return -1
		}
		v := indents[l-1]
		if v == 0 {
			if t := lines[l-1]; len(trimRunes(t)) == 0 {
				v = 1
			} else {
				v = indentOf(t) + 2
			}
			indents[l-1] = v
		}
		return v - 2
	}
	shadowRe := map[string]*RE{}
	shadowedAbove := func(name string, lineNo int) bool {
		indent := indentOf(lineAt(lineNo))
		if indent == 0 {
			return false
		}
		var re *RE
		for l := lineNo - 1; l >= 1 && l > lineNo-600; l-- {
			ind := lineIndent(l)
			if ind < 0 || ind > indent {
				continue
			}
			if ind == 0 {
				return false
			}
			if t := lineAt(l); indexStr(t, name, 0) >= 0 { // both alternatives contain the name
				if re == nil {
					var ok bool
					if re, ok = shadowRe[name]; !ok {
						esc := strings.ReplaceAll(name, "$", `\$`)
						re = mustRE(`\b(?:var|let|const)\s+(?:[^;=]*,\s*)?`+esc+`\b|^\s*,\s*`+esc+`\s*=`, "")
						shadowRe[name] = re
					}
				}
				if re.Test(t) {
					return true
				}
			}
			indent = ind
		}
		return false
	}
	// Field types of the classes in this file: written (`agent: Agent`,
	// constructor parameter properties) or constructed (`self.pool = Pool()`).
	fieldTypeCache := map[*Class]map[string]string{}
	fieldTypes := func(c *Class) map[string]string {
		if ft, ok := fieldTypeCache[c]; ok {
			return ft
		}
		ft := map[string]string{}
		for k, v := range c.Fields.All() {
			ft[k] = v
		}
		fieldTypeCache[c] = ft
		if c.End == 0 {
			return ft
		}
		set := func(name, typ string) {
			if _, has := ft[name]; !has {
				ft[name] = typ
			}
		}
		for l := c.Line; l <= c.End; l++ {
			ln := lineAt(l)
			if py {
				for m := range reCallPyField.Iter(ln, 0) {
					t := m.S(2)
					if t == "" {
						t = m.S(3)
					}
					if t != "" {
						set(m.S(1), t)
					}
				}
			} else {
				for m := range reCallTsField.Iter(ln, 0) {
					set(m.S(1), m.S(2))
				}
				for m := range reCallThisNew.Iter(ln, 0) {
					set(m.S(1), m.S(2))
				}
			}
		}
		return ft
	}
	// The class a type name written in this file refers to (node id), or "".
	classNamed := func(typeName string, line int) string {
		if typeName == "" {
			return ""
		}
		parts := strings.Split(typeName, ".")
		nid := ""
		if len(parts) == 1 {
			if r := b.resolveName(pf, parts[0], line); r != nil {
				nid = r.nid
			}
		} else {
			last := parts[len(parts)-1]
			ns := importedAt(pf, strings.Join(parts[:len(parts)-1], "."), line)
			if ns != nil && ns.Name == "*" && ns.Rel != "" {
				nid = b.perFile.G(ns.Rel).LocalDefs.G(last)
				if nid == "" {
					nid = b.resolveExported(ns.Rel, last)
				}
			}
		}
		if nid == "" {
			return ""
		}
		if node, ok := b.nodeByID[nid]; ok && node.Type == "class" {
			return nid
		}
		return ""
	}
	// A declaration's own name on its header line (`load(): object {`,
	// `def load(self):`) is not a call to whatever `load` the file imports.
	declNames := map[int]map[string]bool{} // 1-based line → names declared there
	noteDecl := func(name string, line int) {
		if declNames[line] == nil {
			declNames[line] = map[string]bool{}
		}
		declNames[line][name] = true
	}
	for _, c := range pf.Decls.Classes {
		noteDecl(c.Name, c.Line)
		for _, meth := range c.Methods {
			noteDecl(meth.Name, meth.Line)
		}
	}
	for _, f := range pf.Decls.Functions {
		noteDecl(f.Name, f.Line)
	}
	seenCalls := map[string]bool{}
	scoped := len(pf.ScopedImports) > 0
	for i, ln := range lines {
		lineNo := i + 1
		// Every pattern below needs a `(` (the argument scan: or a `,`), so a
		// line without one is not searched: `none` starts past the end.
		none := len(ln) + 1
		parenFrom, argFrom, newFrom := none, none, none
		if indexRune(ln, '(', 0) >= 0 {
			parenFrom, argFrom = 0, 0
		} else if indexRune(ln, ',', 0) >= 0 {
			argFrom = 0
		}
		if indexStr(ln, "new", 0) >= 0 {
			newFrom = 0
		}
		headerNames := declNames[lineNo]
		var headerSeen map[string]bool
		if headerNames != nil {
			headerSeen = map[string]bool{}
		}
		// Lookbehind (not a consuming prefix): a consumed delimiter would hide
		// the NEXT match in nested calls like `outer(inner())`.
		parenLine := ln
		if parenFrom != 0 {
			parenLine = nil
		}
		for _, m := range scanCalls(parenLine) { // reCallCall
			name := m.name
			if callKeywords[name] {
				continue
			}
			if headerNames != nil && headerNames[name] && !headerSeen[name] {
				headerSeen[name] = true
				continue
			}
			region := regionAt(lineNo)
			caller := pf.FileNid
			if region != nil {
				caller = region.nid
			}
			// a parameter or local of the enclosing function, not the file-level name
			if region != nil && !region.isClass && pf.LocalDefs.G(name) != region.nid && infoOf(region).locals[name] && !(scoped && importedAt(pf, name, lineNo) != pf.ImportedNames.G(name)) {
				continue
			}
			if region == nil && !py && shadowedAbove(name, lineNo) {
				continue
			}
			r := b.resolveName(pf, name, lineNo)
			if r == nil && !pf.LocalDefs.Has(name) {
				bound := importedAt(pf, name, lineNo)
				if bound != nil && bound.Cjs && bound.Rel != "" {
					// the function the module assigns to module.exports, else the module itself
					moduleNid := b.defaultOf(bound.Rel)
					if moduleNid == "" {
						moduleNid = b.perFile.G(bound.Rel).FileNid
					}
					key := caller + "|" + moduleNid + "|calls"
					if moduleNid != caller && !seenCalls[key] {
						seenCalls[key] = true
						b.addEdge(caller, moduleNid, "calls", edgeOpts{File: rel, Line: lineNo, Context: "call"})
					}
				}
			}
			if r == nil || r.nid == caller {
				continue
			}
			key := caller + "|" + r.nid + "|calls"
			if seenCalls[key] {
				continue
			}
			seenCalls[key] = true
			target := b.nodeByID[r.nid]
			if target == nil || !target.Callable {
				// calling a class = instantiation in py; skip non-callables otherwise
				if target != nil && target.Type == "class" && pf.Lang == "python" {
					b.addEdge(caller, r.nid, "instantiates", edgeOpts{File: rel, Line: lineNo, Confidence: r.confidence, Context: "call"})
				}
				continue
			}
			o := edgeOpts{File: rel, Line: lineNo, Confidence: r.confidence, Context: "call"}
			if r.confidence == "INFERRED" {
				o.Score, o.HasScore = inferredCallScore, true
			}
			b.addEdge(caller, r.nid, "calls", o)
		}
		// this.x()/self.x() → the ENCLOSING class's method, never an earlier
		// unrelated class that happens to share the method name.
		for sm := range reCallSelf.Iter(ln, parenFrom) {
			member := sm.S(1)
			caller := regionOf(lineNo)
			var owner *Class
			for _, c := range pf.Decls.Classes {
				if c.Line > lineNo {
					continue
				}
				if c.End != 0 && lineNo > c.End {
					continue
				}
				for _, x := range c.Methods {
					if x.Name == member {
						owner = c
						break
					}
				}
			}
			mid := ""
			if owner != nil {
				mid = owner.MethodIds.G(member)
			}
			if mid == "" {
				if region := regionAt(lineNo); region != nil && region.classNid != "" {
					mid = b.memberOf(region.classNid, member, 1, 0)
				}
			}
			if mid != "" {
				key := caller + "|" + mid + "|calls"
				if !seenCalls[key] && mid != caller {
					seenCalls[key] = true
					b.addEdge(caller, mid, "calls", edgeOpts{File: rel, Line: lineNo, Context: "call"})
				}
			}
		}
		// ns.member() through a known imported namespace — `import * as util
		// from './util.js'; util.helper()` must record a call edge; the bare
		// callRe deliberately excludes dotted names. The receiver must START
		// a reference (`other.util.helper()` is a property chain, not the
		// import) and must not be shadowed by a module-level declaration.
		// Lookbehind, not a consuming prefix: `util.outer(util.inner())`
		// must match the inner call too.
		for _, nc := range scanNsCalls(parenLine) { // reCallNs
			recv := nc.recv
			recv = recv[:len(recv)-1]
			member := nc.member
			if recv == "this" || recv == "self" {
				continue
			}
			if pf.LocalDefs.Has(firstSeg(recv)) && !pf.LocalDefs.Has(recv) {
				continue
			}
			tnid, relation := "", "calls"
			imp := importedAt(pf, recv, lineNo)
			if imp != nil && imp.Name == "*" && imp.Rel != "" && !pf.LocalDefs.Has(recv) {
				if tpfNs, ok := b.perFile.Get(imp.Rel); ok {
					tnid = tpfNs.LocalDefs.G(member)
				}
				if tnid == "" {
					tnid = b.resolveExported(imp.Rel, member)
				}
			} else {
				region := regionAt(lineNo)
				segs := strings.Split(recv, ".")
				typeName, known := "", false
				if (segs[0] == "this" || segs[0] == "self") && len(segs) == 2 && region != nil && region.cls != nil {
					typeName = fieldTypes(region.cls)[segs[1]]
				} else if len(segs) == 1 {
					// `Name.member()` on a class of the repo: a static or class method
					var owner *resolvedName
					if !(region != nil && !region.isClass && infoOf(region).locals[recv]) {
						owner = b.resolveName(pf, recv, lineNo)
					}
					if owner != nil {
						known = true
						if n, ok := b.nodeByID[owner.nid]; ok && n.Type == "class" {
							tnid = b.memberOf(owner.nid, member, 0, 0)
						}
					} else {
						bound := importedAt(pf, recv, lineNo)
						if bound != nil && !(region != nil && !region.isClass && infoOf(region).locals[recv]) {
							known = true // an import: its members are not this repo's methods
						} else if region != nil && !region.isClass {
							typeName = infoOf(region).types[recv]
						}
					}
				}
				if tnid == "" && !known {
					if cls := classNamed(typeName, lineNo); cls != "" {
						tnid = b.memberOf(cls, member, 0, 0)
					} else {
						external := false
						if typeName != "" {
							if tb := importedAt(pf, firstSeg(typeName), lineNo); tb != nil && tb.External {
								external = true
							}
						}
						if !external {
							tnid = b.uniqueMethod(pf.Lang, member)
							if tnid != "" {
								relation = "inferred"
							}
						}
					}
				}
			}
			if tnid == "" {
				continue
			}
			target := b.nodeByID[tnid]
			if target == nil {
				continue
			}
			if !target.Callable {
				if target.Type != "class" || pf.Lang != "python" {
					continue
				}
				relation = "instantiates"
			}
			caller := regionOf(lineNo)
			if tnid == caller {
				continue
			}
			inferred := relation == "inferred"
			if inferred {
				relation = "calls"
			}
			key := caller + "|" + tnid + "|" + relation
			if seenCalls[key] {
				continue
			}
			seenCalls[key] = true
			o := edgeOpts{File: rel, Line: lineNo, Context: "call"}
			if inferred {
				o.Confidence = "INFERRED"
				o.Score, o.HasScore = inferredCallScore, true
			}
			b.addEdge(caller, tnid, relation, o)
		}
		for m := range reCallNew.Iter(ln, newFrom) {
			name := firstSeg(m.S(1))
			r := b.resolveName(pf, name, lineNo)
			if r == nil {
				continue
			}
			caller := regionOf(lineNo)
			key := caller + "|" + r.nid + "|instantiates"
			if seenCalls[key] || r.nid == caller {
				continue
			}
			seenCalls[key] = true
			b.addEdge(caller, r.nid, "instantiates", edgeOpts{File: rel, Line: lineNo, Confidence: r.confidence, Context: "call"})
		}
		// indirect_call: known callable passed as a bare argument — f(cb) / f(x, cb).
		// The delimiter after the name is a lookahead: consuming it would hide
		// the next argument's leading comma (`f(a, b, c)` would lose `b`).
		for m := range reCallArg.Iter(ln, argFrom) {
			name := m.S(1)
			if callKeywords[name] {
				continue
			}
			nid := ""
			if pf.LocalDefs.Has(name) {
				nid = pf.LocalDefs.G(name)
			} else if imp := pf.ImportedNames.G(name); imp != nil && imp.Nid != "" {
				nid = imp.Nid
			} else {
				continue
			}
			target := b.nodeByID[nid]
			if target == nil || !target.Callable {
				continue
			}
			caller := regionOf(lineNo)
			key := caller + "|" + nid + "|indirect_call"
			if seenCalls[key] || nid == caller || seenCalls[caller+"|"+nid+"|calls"] {
				continue
			}
			seenCalls[key] = true
			b.addEdge(caller, nid, "indirect_call", edgeOpts{File: rel, Line: lineNo, Confidence: "INFERRED", Score: inferredCallScore, HasScore: true, Context: "call"})
		}
	}
}

// firstOf is `s.split(sep)[0]`.
func firstOf(s, sep string) string {
	if i := strings.Index(s, sep); i >= 0 {
		return s[:i]
	}
	return s
}

// fromIfAny is the search start for a pattern that cannot match unless the
// line holds one of the given literals: 0 when one is present, past the end
// (no search) otherwise.
func fromIfAny(ln []rune, literals ...string) int {
	for _, s := range literals {
		if indexStr(ln, s, 0) >= 0 {
			return 0
		}
	}
	return len(ln) + 1
}
