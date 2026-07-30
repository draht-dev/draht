package parse

import "strings"

// grammarFor maps a (Lang, path) pair to a gotreesitter grammar name (i.e. a
// name accepted by grammars.DetectLanguageByName). path is used only to
// disambiguate the one Lang that spans two grammars: "typescript" covers both
// the "typescript" and "tsx" grammars, split on the file extension. Every
// other Lang maps to a single grammar regardless of path.
//
// Returns "" for languages parse does not (yet) know how to map to a grammar
// name; callers treat that as "unsupported".
func grammarFor(lang Lang, path string) string {
	switch lang {
	case "typescript":
		if strings.HasSuffix(strings.ToLower(path), ".tsx") {
			return "tsx"
		}
		return "typescript"
	case "javascript":
		return "javascript"
	case "python":
		return "python"
	case "go":
		return "go"
	case "rust":
		return "rust"
	case "java":
		return "java"
	case "kotlin":
		return "kotlin"
	case "swift":
		return "swift"
	case "ruby":
		return "ruby"
	case "php":
		return "php"
	case "csharp":
		return "c_sharp"
	case "c":
		return "c"
	case "cpp":
		return "cpp"
	case "shell":
		return "bash"
	default:
		return ""
	}
}
