package scan

import (
	"context"
	"os/exec"
	"path/filepath"
	"strings"
)

// GitFiles returns the tracked-plus-untracked-not-ignored file set under
// root via `git ls-files --cached --others --exclude-standard -z`.
//
// ok is false when git is unavailable or root is not a repository; callers
// MUST fall back to Walk in that case — this is never a fatal error (see
// design §R8). Verbatim port of visGitFileFilter (draht-tools.cjs:1300-1310).
func GitFiles(ctx context.Context, root string) (files []string, ok bool) {
	cmd := exec.CommandContext(ctx, "git", "ls-files", "--cached", "--others", "--exclude-standard", "-z")
	cmd.Dir = root
	out, err := cmd.Output()
	if err != nil {
		return nil, false
	}

	parts := strings.Split(string(out), "\x00")
	files = make([]string, 0, len(parts))
	for _, p := range parts {
		if p == "" {
			continue
		}
		files = append(files, filepath.ToSlash(p))
	}
	return files, true
}
