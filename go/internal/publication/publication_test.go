package publication_test

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/draht-dev/draht/go/internal/graph"
	"github.com/draht-dev/draht/go/internal/parse"
	"github.com/draht-dev/draht/go/internal/publication"
)

const helperEnv = "DRAHT_PUBLICATION_HELPER"

type barrierParser struct {
	inner   parse.Parser
	entered string
	release string
}

func (p *barrierParser) Supports(lang parse.Lang) bool { return p.inner.Supports(lang) }
func (p *barrierParser) Version() string               { return p.inner.Version() }
func (p *barrierParser) Close() error                  { return p.inner.Close() }
func (p *barrierParser) Extract(ctx context.Context, lang parse.Lang, path string, src []byte) (parse.Result, error) {
	if err := os.WriteFile(p.entered, []byte("entered"), 0o644); err != nil {
		return parse.Result{}, err
	}
	for {
		if _, err := os.Stat(p.release); err == nil {
			break
		} else if !os.IsNotExist(err) {
			return parse.Result{}, err
		}
		select {
		case <-ctx.Done():
			return parse.Result{}, ctx.Err()
		case <-time.After(10 * time.Millisecond):
		}
	}
	return p.inner.Extract(ctx, lang, path, src)
}

func TestPublicationHelperProcess(t *testing.T) {
	if os.Getenv(helperEnv) == "" {
		return
	}
	root := os.Getenv("DRAHT_PUBLICATION_ROOT")
	out := os.Getenv("DRAHT_PUBLICATION_OUT")
	cacheDir := os.Getenv("DRAHT_PUBLICATION_CACHE")
	if started := os.Getenv("DRAHT_PUBLICATION_STARTED"); started != "" {
		if err := os.WriteFile(started, []byte("started"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var parser parse.Parser = parse.NewRegex()
	if entered := os.Getenv("DRAHT_PUBLICATION_ENTERED"); entered != "" {
		parser = &barrierParser{inner: parser, entered: entered, release: os.Getenv("DRAHT_PUBLICATION_RELEASE")}
	}
	defer parser.Close()

	_, _, _, err := publication.Build(context.Background(), graph.Options{
		Root: root, OutDir: out, CacheDir: cacheDir, Parser: parser, Jobs: 1,
	}, false)
	if err != nil {
		t.Fatal(err)
	}
}

func TestTwoProcessesCannotPublishOlderGenerationAfterNewerGeneration(t *testing.T) {
	root := t.TempDir()
	out := filepath.Join(root, ".planning", "codebase")
	cacheDir := filepath.Join(root, ".cache", "graph")
	if err := os.WriteFile(filepath.Join(root, "old-generation.ts"), []byte("export const oldGeneration = 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	entered := filepath.Join(t.TempDir(), "entered")
	release := filepath.Join(t.TempDir(), "release")
	old := helperCommand(t, root, out, cacheDir, entered, release, "")
	var oldOutput bytes.Buffer
	old.Stdout = &oldOutput
	old.Stderr = &oldOutput
	if err := old.Start(); err != nil {
		t.Fatal(err)
	}
	waitForFile(t, entered)

	if err := os.Remove(filepath.Join(root, "old-generation.ts")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "new-generation.ts"), []byte("export const newGeneration = 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	newStarted := filepath.Join(t.TempDir(), "new-started")
	newer := helperCommand(t, root, out, cacheDir, "", "", newStarted)
	var newOutput bytes.Buffer
	newer.Stdout = &newOutput
	newer.Stderr = &newOutput
	if err := newer.Start(); err != nil {
		t.Fatal(err)
	}
	waitForFile(t, newStarted)
	if err := os.WriteFile(release, []byte("release"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := old.Wait(); err != nil {
		t.Fatalf("older process: %v\n%s", err, oldOutput.Bytes())
	}
	if err := newer.Wait(); err != nil {
		t.Fatalf("newer process: %v\n%s", err, newOutput.Bytes())
	}

	for _, name := range []string{"MAP.json", "MAP.html", "GRAPH_REPORT.md", filepath.Join("..", "..", ".cache", "graph", "facts.ndjson")} {
		path := filepath.Join(out, name)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		text := string(data)
		if strings.Contains(text, "old-generation") || !strings.Contains(text, "new-generation") {
			t.Errorf("%s published stale/mixed generation", path)
		}
	}
}

func TestJavaScriptAndGoCannotPublishOlderGenerationAfterNewerGeneration(t *testing.T) {
	root := t.TempDir()
	out := filepath.Join(root, ".planning", "codebase")
	cacheDir := filepath.Join(root, ".cache", "graph")
	oldPath := filepath.Join(root, "old-generation.ts")
	if err := os.WriteFile(oldPath, []byte("export const oldGeneration = 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	entered := filepath.Join(t.TempDir(), "js-entered")
	release := filepath.Join(t.TempDir(), "js-release")
	preload := filepath.Join(t.TempDir(), "block-publication.cjs")
	script := `const fs=require("node:fs"); const path=require("node:path"); const original=fs.writeFileSync; let blocked=false; fs.writeFileSync=function(p,...args){ if(!blocked && path.basename(String(p))==="MAP.json"){ blocked=true; original(process.env.DRAHT_JS_ENTERED,"entered"); while(!fs.existsSync(process.env.DRAHT_JS_RELEASE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); } return original.call(this,p,...args); };`
	if err := os.WriteFile(preload, []byte(script), 0o644); err != nil {
		t.Fatal(err)
	}
	cli, err := filepath.Abs(filepath.Join("..", "..", "..", "packages", "draht-tools", "bin", "draht-tools.cjs"))
	if err != nil {
		t.Fatal(err)
	}
	old := exec.Command("node", "--require", preload, cli, "map-graph")
	old.Dir = root
	old.Env = append(os.Environ(), "DRAHT_GRAPH_ENGINE=js", "DRAHT_JS_ENTERED="+entered, "DRAHT_JS_RELEASE="+release)
	var oldOutput bytes.Buffer
	old.Stdout, old.Stderr = &oldOutput, &oldOutput
	if err := old.Start(); err != nil {
		t.Fatal(err)
	}
	waitForFile(t, entered)
	if err := os.Remove(oldPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "new-generation.ts"), []byte("export const newGeneration = 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	newer := helperCommand(t, root, out, cacheDir, "", "", "")
	var newOutput bytes.Buffer
	newer.Stdout, newer.Stderr = &newOutput, &newOutput
	if err := newer.Start(); err != nil {
		t.Fatal(err)
	}
	// Before coordination, Go can finish while the older JS writer is blocked;
	// with the shared protocol it remains queued. The deadline only detects
	// which state applies; ordering comes from the explicit JS publication gate.
	deadline := time.Now().Add(750 * time.Millisecond)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(filepath.Join(out, "MAP.json")); err == nil && strings.Contains(string(data), "new-generation") {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := os.WriteFile(release, []byte("release"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := old.Wait(); err != nil {
		t.Fatalf("JavaScript process: %v\n%s", err, oldOutput.Bytes())
	}
	if err := newer.Wait(); err != nil {
		t.Fatalf("Go process: %v\n%s", err, newOutput.Bytes())
	}
	for _, name := range []string{"MAP.json", "MAP.html", "GRAPH_REPORT.md", filepath.Join("..", "..", ".cache", "graph", "facts.ndjson")} {
		data, err := os.ReadFile(filepath.Join(out, name))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), "old-generation") || !strings.Contains(string(data), "new-generation") {
			t.Errorf("%s published stale/mixed JS/Go generation", name)
		}
	}
}

func TestSameProcessRegenerationStillPublishesChangedSource(t *testing.T) {
	root := t.TempDir()
	out := filepath.Join(root, ".planning", "codebase")
	cacheDir := filepath.Join(root, ".cache", "graph")
	oldPath := filepath.Join(root, "old-generation.ts")
	if err := os.WriteFile(oldPath, []byte("export const oldGeneration = 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	parser := parse.NewRegex()
	defer parser.Close()
	opts := graph.Options{Root: root, OutDir: out, CacheDir: cacheDir, Parser: parser, Jobs: 1}
	if _, _, _, err := publication.Build(context.Background(), opts, false); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(oldPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "new-generation.ts"), []byte("export const newGeneration = 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, report, _, err := publication.Build(context.Background(), opts, false); err != nil {
		t.Fatal(err)
	} else if !report.Changed {
		t.Fatal("second generation reported unchanged")
	}
	for _, name := range []string{"MAP.json", "MAP.html", "GRAPH_REPORT.md", filepath.Join("..", "..", ".cache", "graph", "facts.ndjson")} {
		path := filepath.Join(out, name)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), "old-generation") || !strings.Contains(string(data), "new-generation") {
			t.Errorf("%s did not regenerate coherently", path)
		}
	}
	stages, err := filepath.Glob(filepath.Join(out, ".map-publish-stage-*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(stages) != 0 {
		t.Fatalf("staging directories leaked: %v", stages)
	}
}

func helperCommand(t *testing.T, root, out, cacheDir, entered, release, started string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestPublicationHelperProcess$")
	cmd.Env = append(os.Environ(),
		helperEnv+"=1",
		"DRAHT_PUBLICATION_ROOT="+root,
		"DRAHT_PUBLICATION_OUT="+out,
		"DRAHT_PUBLICATION_CACHE="+cacheDir,
		"DRAHT_PUBLICATION_ENTERED="+entered,
		"DRAHT_PUBLICATION_RELEASE="+release,
		"DRAHT_PUBLICATION_STARTED="+started,
	)
	return cmd
}

func waitForFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(path); err == nil {
			return
		} else if !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", path)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
