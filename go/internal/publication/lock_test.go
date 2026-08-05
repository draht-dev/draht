package publication

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestObsoleteOwnerCannotHeartbeatOrReleaseSuccessor(t *testing.T) {
	out := filepath.Join(t.TempDir(), "output")
	first, err := acquire(context.Background(), out)
	if err != nil {
		t.Fatal(err)
	}
	quarantine := first.dir + ".stale-test"
	if err := os.Rename(first.dir, quarantine); err != nil {
		t.Fatal(err)
	}
	second, err := createLock(first.dir)
	if err != nil {
		t.Fatal(err)
	}
	// Freeze the successor's own heartbeat. An obsolete heartbeat must not be
	// able to keep the successor's lease alive through a reused lock pathname.
	close(second.stop)
	<-second.done
	infoBefore, err := os.Stat(second.owner)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * lockHeartbeat)
	infoAfter, err := os.Stat(second.owner)
	if err != nil {
		t.Fatal(err)
	}
	if infoAfter.ModTime().After(infoBefore.ModTime()) {
		t.Fatal("obsolete owner refreshed successor heartbeat")
	}
	first.release()
	data, err := os.ReadFile(second.owner)
	if err != nil {
		t.Fatalf("obsolete owner removed successor: %v", err)
	}
	var owner lockOwner
	if json.Unmarshal(data, &owner) != nil || owner.Token != second.token {
		t.Fatal("successor ownership changed")
	}
}

func TestCrashLockHelperProcess(t *testing.T) {
	if os.Getenv("DRAHT_CRASH_LOCK_HELPER") == "" {
		return
	}
	lock, err := acquire(context.Background(), os.Getenv("DRAHT_CRASH_LOCK_OUT"))
	if err != nil {
		t.Fatal(err)
	}
	defer lock.release()
	if err := os.WriteFile(os.Getenv("DRAHT_CRASH_LOCK_READY"), []byte("ready"), 0o644); err != nil {
		t.Fatal(err)
	}
	select {}
}

func TestInterprocessLockIsReleasedWhenHolderCrashes(t *testing.T) {
	out := filepath.Join(t.TempDir(), "output")
	ready := filepath.Join(t.TempDir(), "ready")
	cmd := exec.Command(os.Args[0], "-test.run=^TestCrashLockHelperProcess$")
	cmd.Env = append(os.Environ(),
		"DRAHT_CRASH_LOCK_HELPER=1",
		"DRAHT_CRASH_LOCK_OUT="+out,
		"DRAHT_CRASH_LOCK_READY="+ready,
	)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	waitForPath(t, ready)
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err == nil {
		t.Fatal("killed lock holder exited successfully")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	lock, err := acquire(ctx, out)
	if err != nil {
		t.Fatalf("acquire after holder crash: %v", err)
	}
	lock.release()
}

func TestAcquireRejectsSymlinkLockPathWithoutTouchingTarget(t *testing.T) {
	out := filepath.Join(t.TempDir(), "output")
	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}
	victim := t.TempDir()
	marker := filepath.Join(victim, "keep")
	if err := os.WriteFile(marker, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, filepath.Join(out, lockDirName)); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if lock, err := acquire(ctx, out); err == nil {
		lock.release()
		t.Fatal("acquired through a symlink lock path")
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != "keep" {
		t.Fatalf("symlink target was modified: data=%q err=%v", data, err)
	}
}

func TestGoRecoversAfterJavaScriptLockHolderCrashes(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "index.ts"), []byte("export const x = 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ready := filepath.Join(t.TempDir(), "ready")
	preload := filepath.Join(t.TempDir(), "hold-lock.cjs")
	script := `const fs=require("node:fs"),cp=require("node:child_process");const spawn=cp.spawn;cp.spawn=function(...args){const child=spawn.apply(this,args);if(Array.isArray(args[1])&&String(args[1][1]||"").includes("process.on(\"disconnect\"")){fs.writeFileSync(process.env.DRAHT_LOCK_READY,"ready");for(;;)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000)}return child};`
	if err := os.WriteFile(preload, []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	cli, err := filepath.Abs(filepath.Join("..", "..", "..", "packages", "draht-tools", "bin", "draht-tools.cjs"))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("node", "--require", preload, cli, "map-graph", "--quiet")
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "DRAHT_GRAPH_ENGINE=js", "DRAHT_LOCK_READY="+ready)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	waitForPath(t, ready)
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	lock, err := acquire(ctx, filepath.Join(root, ".planning", "codebase"))
	if err != nil {
		t.Fatalf("Go did not recover JavaScript crash: %v", err)
	}
	lock.release()
}

func waitForPath(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(path); err == nil {
			return
		} else if !os.IsNotExist(err) {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", path)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
