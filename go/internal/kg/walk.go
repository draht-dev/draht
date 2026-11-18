package kg

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// Repo walk.

func pathExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func findRepoRoot(startDir string) string {
	start, err := filepath.Abs(startDir)
	if err != nil {
		start = startDir
	}
	dir := start
	for {
		if pathExists(filepath.Join(dir, ".git")) {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	dir = start
	for {
		if raw, err := os.ReadFile(filepath.Join(dir, "package.json")); err == nil {
			var pj map[string]json.RawMessage
			if json.Unmarshal(raw, &pj) == nil {
				if ws, ok := pj["workspaces"]; ok && jsTruthyJSON(ws) {
					return dir
				}
			}
		}
		if pathExists(filepath.Join(dir, "pnpm-workspace.yaml")) {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return start
}

// jsTruthyJSON reports whether a JSON value is truthy in JavaScript.
func jsTruthyJSON(raw json.RawMessage) bool {
	s := strings.TrimSpace(string(raw))
	switch s {
	case "", "null", "false", `""`, "0", "-0", "0.0":
		return false
	}
	return true
}

// jsExtname is Node's path.extname: "" for a dot file (`.bashrc`).
func jsExtname(p string) string {
	base := p
	if i := strings.LastIndexAny(p, `/\`); i >= 0 {
		base = p[i+1:]
	}
	dot := strings.LastIndexByte(base, '.')
	if dot <= 0 {
		return ""
	}
	return base[dot:]
}

// sortByPosixPath orders paths by their "/"-normalized form. Sorting the OS
// form would order `a\b.ts` against `a0.ts` differently from `a/b.ts`
// (backslash sorts after digits and capitals, slash before), and the first
// file wins an id collision — so the same repo must not index differently per
// OS.
func sortByPosixPath(paths []string) []string {
	out := append([]string(nil), paths...)
	sort.SliceStable(out, func(i, j int) bool {
		return filepath.ToSlash(out[i]) < filepath.ToSlash(out[j])
	})
	return out
}

// gitFiles lists the code files of a git checkout: tracked files and
// untracked ones git does not ignore, so a tracked dot-directory counts and
// ignored build output does not. Nil outside a git checkout (or without git):
// the directory walk and its ignore list take over.
func gitFiles(root string, maxFiles int) []string {
	if !pathExists(filepath.Join(root, ".git")) {
		return nil
	}
	cmd := exec.Command("git", "-C", root, "ls-files", "-co", "--exclude-standard", "-z")
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		return nil
	}
	var files []string
	for _, rel := range strings.Split(stdout.String(), "\x00") {
		if rel == "" || strings.HasSuffix(rel, "/") || kgLangByExt[strings.ToLower(jsExtname(rel))] == "" {
			continue
		}
		parts := strings.Split(rel, "/")
		skip := false
		for _, p := range parts {
			if p == "node_modules" || p == ".git" {
				skip = true
				break
			}
		}
		if skip {
			continue
		}
		full := filepath.Join(append([]string{root}, parts...)...)
		if st, err := os.Stat(full); err != nil || !st.Mode().IsRegular() {
			continue
		}
		files = append(files, full)
		if len(files) >= maxFiles {
			break
		}
	}
	if len(files) == 0 {
		return nil
	}
	return sortByPosixPath(files)
}

func walk(root string) []string {
	const maxFiles = 20000
	if tracked := gitFiles(root, maxFiles); tracked != nil {
		return tracked
	}
	var files []string
	stack := []string{root}
	for len(stack) > 0 && len(files) < maxFiles {
		dir := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		entries, err := os.ReadDir(dir) // sorted by name
		if err != nil {
			continue
		}
		for _, e := range entries {
			name := e.Name()
			if kgIgnores[name] {
				continue
			}
			if strings.HasPrefix(name, ".") && e.IsDir() {
				continue
			}
			full := filepath.Join(dir, name)
			if e.IsDir() {
				stack = append(stack, full)
			} else if e.Type().IsRegular() && kgLangByExt[strings.ToLower(jsExtname(name))] != "" {
				files = append(files, full)
			}
		}
	}
	return sortByPosixPath(files)
}
