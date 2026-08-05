// Package publication coordinates complete graph builds and publishes their
// artifacts without allowing competing processes to overwrite a newer source
// generation with an older one.
package publication

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/draht-dev/draht/go/internal/emit"
	"github.com/draht-dev/draht/go/internal/graph"
	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/scan"
)

const lockDirName = ".map-publish-lock"

// Build runs graph assembly and derived-output rendering under an
// output-scoped inter-process lock. Every attempt is rendered in a unique
// staging directory. If source inputs changed while an attempt was running,
// its staged artifacts are discarded and the build is retried before any
// publication occurs.
func Build(ctx context.Context, opts graph.Options, quiet bool) (*model.Map, graph.Report, emit.Result, error) {
	root := opts.Root
	if root == "" {
		resolved, err := scan.FindRepoRoot(".")
		if err != nil {
			return model.NewMap(), graph.Report{}, emit.Result{}, fmt.Errorf("publication: resolve repo root: %w", err)
		}
		root = resolved
		opts.Root = root
	}
	outDir := opts.OutDir
	if outDir == "" {
		outDir = scan.GraphOutDir(root)
	}

	lock, err := acquire(ctx, outDir)
	if err != nil {
		return model.NewMap(), graph.Report{}, emit.Result{}, err
	}
	defer lock.release()

	for {
		if err := ctx.Err(); err != nil {
			return model.NewMap(), graph.Report{}, emit.Result{}, fmt.Errorf("publication: build: %w", err)
		}
		before, err := sourceGeneration(root)
		if err != nil {
			return model.NewMap(), graph.Report{}, emit.Result{}, err
		}

		stage, err := os.MkdirTemp(outDir, ".map-publish-stage-")
		if err != nil {
			return model.NewMap(), graph.Report{}, emit.Result{}, fmt.Errorf("publication: create stage: %w", err)
		}
		m, report, result, attemptErr := buildAttempt(ctx, opts, root, outDir, stage, quiet)
		if attemptErr != nil {
			_ = os.RemoveAll(stage)
			return m, report, result, attemptErr
		}

		after, err := sourceGeneration(root)
		if err != nil {
			_ = os.RemoveAll(stage)
			return m, report, result, err
		}
		if before != after {
			_ = os.RemoveAll(stage)
			continue
		}

		if err := publishAttempt(opts, root, outDir, stage, report.Changed, quiet); err != nil {
			_ = os.RemoveAll(stage)
			return m, report, result, err
		}
		_ = os.RemoveAll(stage)
		result.JSONPath = filepath.Join(outDir, "MAP.json")
		result.HTMLPath = filepath.Join(outDir, "MAP.html")
		result.ReportPath = filepath.Join(outDir, "GRAPH_REPORT.md")
		return m, report, result, nil
	}
}

func buildAttempt(ctx context.Context, opts graph.Options, root, outDir, stage string, quiet bool) (*model.Map, graph.Report, emit.Result, error) {
	stageOut := filepath.Join(stage, "output")
	if err := os.MkdirAll(stageOut, 0o755); err != nil {
		return model.NewMap(), graph.Report{}, emit.Result{}, fmt.Errorf("publication: create output stage: %w", err)
	}
	if err := copyIfExists(filepath.Join(outDir, "MAP.json"), filepath.Join(stageOut, "MAP.json")); err != nil {
		return model.NewMap(), graph.Report{}, emit.Result{}, err
	}

	attemptOpts := opts
	attemptOpts.Root = root
	attemptOpts.OutDir = stageOut
	if !opts.NoCache {
		cacheDir := opts.CacheDir
		if cacheDir == "" {
			cacheDir = scan.CacheDir(root)
		}
		stageCache := filepath.Join(stage, "cache")
		if err := copyIfExists(filepath.Join(cacheDir, "facts.ndjson"), filepath.Join(stageCache, "facts.ndjson")); err != nil {
			return model.NewMap(), graph.Report{}, emit.Result{}, err
		}
		attemptOpts.CacheDir = stageCache
	}

	m, report, err := graph.Build(ctx, attemptOpts)
	if err != nil {
		return m, report, emit.Result{}, err
	}
	result, err := emit.WriteOutputs(stageOut, m, report.Changed, quiet)
	if err != nil {
		return m, report, result, err
	}
	return m, report, result, nil
}

func publishAttempt(opts graph.Options, root, outDir, stage string, changed, quiet bool) error {
	stageOut := filepath.Join(stage, "output")
	// Derived files go first and MAP.json last. MAP.json is the source-of-truth
	// commit marker, so observing the new map implies its derived outputs have
	// already reached their final names.
	if changed {
		if err := renameIfExists(filepath.Join(stageOut, "GRAPH_REPORT.md"), filepath.Join(outDir, "GRAPH_REPORT.md")); err != nil {
			return err
		}
	}
	if !quiet {
		if err := renameIfExists(filepath.Join(stageOut, "MAP.html"), filepath.Join(outDir, "MAP.html")); err != nil {
			return err
		}
	}

	if !opts.NoCache {
		cacheDir := opts.CacheDir
		if cacheDir == "" {
			cacheDir = scan.CacheDir(root)
		}
		if err := renameIfExists(filepath.Join(stage, "cache", "facts.ndjson"), filepath.Join(cacheDir, "facts.ndjson")); err != nil {
			return err
		}
		if err := renameIfExists(filepath.Join(stage, "cache", ".gitignore"), filepath.Join(cacheDir, ".gitignore")); err != nil {
			return err
		}
	}
	if changed {
		if err := renameIfExists(filepath.Join(stageOut, "MAP.json"), filepath.Join(outDir, "MAP.json")); err != nil {
			return err
		}
	}
	return nil
}

func copyIfExists(src, dst string) error {
	in, err := os.Open(src)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("publication: open %s: %w", src, err)
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("publication: mkdir %s: %w", filepath.Dir(dst), err)
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("publication: create %s: %w", dst, err)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return fmt.Errorf("publication: copy %s: %w", src, err)
	}
	if err := out.Close(); err != nil {
		return fmt.Errorf("publication: close %s: %w", dst, err)
	}
	return nil
}

func renameIfExists(src, dst string) error {
	if _, err := os.Stat(src); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return fmt.Errorf("publication: stat %s: %w", src, err)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("publication: mkdir %s: %w", filepath.Dir(dst), err)
	}
	if err := os.Rename(src, dst); err != nil {
		return fmt.Errorf("publication: publish %s: %w", dst, err)
	}
	return nil
}

func sourceGeneration(root string) ([sha256.Size]byte, error) {
	h := sha256.New()
	discovery, err := scan.Discover(root)
	if err != nil {
		return [sha256.Size]byte{}, fmt.Errorf("publication: discover generation: %w", err)
	}
	for _, file := range discovery.Files {
		_, _ = io.WriteString(h, file.Rel)
		_, _ = h.Write([]byte{0})
		data, readErr := os.ReadFile(file.Abs)
		if readErr != nil {
			_, _ = io.WriteString(h, readErr.Error())
		} else {
			_, _ = h.Write(data)
		}
		_, _ = h.Write([]byte{0})
	}
	graphOutDir := scan.GraphOutDir(root)
	for _, path := range []string{
		filepath.Join(graphOutDir, "GROUPS.json"),
		filepath.Join(graphOutDir, "FLOWS.json"),
		filepath.Join(root, scan.PlanningDir, "STATE.md"),
		filepath.Join(root, scan.PlanningDir, "ROADMAP.md"),
		filepath.Join(root, scan.PlanningDir, "PROJECT.md"),
		filepath.Join(root, scan.PlanningDir, "DOMAIN.md"),
		filepath.Join(root, scan.PlanningDir, "DOMAIN-MODEL.md"),
	} {
		_, _ = io.WriteString(h, path)
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			_, _ = io.WriteString(h, readErr.Error())
		} else {
			_, _ = h.Write(data)
		}
		_, _ = h.Write([]byte{0})
	}
	var sum [sha256.Size]byte
	copy(sum[:], h.Sum(nil))
	return sum, nil
}

type fileLock struct{ file *os.File }

func acquire(ctx context.Context, outDir string) (*fileLock, error) {
	canonical, err := filepath.Abs(outDir)
	if err != nil {
		return nil, fmt.Errorf("publication: resolve output: %w", err)
	}
	if resolved, evalErr := filepath.EvalSymlinks(canonical); evalErr == nil {
		canonical = resolved
	}
	if err := os.MkdirAll(canonical, 0o755); err != nil {
		return nil, fmt.Errorf("publication: create output: %w", err)
	}
	lockDir := filepath.Join(canonical, lockDirName)
	if err := os.MkdirAll(lockDir, 0o755); err != nil {
		return nil, fmt.Errorf("publication: create lock directory: %w", err)
	}
	file, err := os.OpenFile(filepath.Join(lockDir, "lock"), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, fmt.Errorf("publication: open lock: %w", err)
	}
	for {
		locked, lockErr := tryLockFile(file)
		if lockErr != nil {
			file.Close()
			return nil, fmt.Errorf("publication: lock: %w", lockErr)
		}
		if locked {
			return &fileLock{file: file}, nil
		}
		select {
		case <-ctx.Done():
			file.Close()
			return nil, fmt.Errorf("publication: lock: %w", ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func (l *fileLock) release() {
	_ = unlockFile(l.file)
	_ = l.file.Close()
}
