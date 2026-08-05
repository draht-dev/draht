package publication

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

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
