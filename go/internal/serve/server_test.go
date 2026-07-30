package serve

import (
	"bytes"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

func newTestState(t *testing.T) *state {
	t.Helper()
	dir := t.TempDir()
	jsonPath := filepath.Join(dir, "MAP.json")
	htmlPath := filepath.Join(dir, "MAP.html")
	if err := os.WriteFile(jsonPath, []byte(`{"schemaVersion":5}`), 0o644); err != nil {
		t.Fatalf("seed MAP.json: %v", err)
	}
	if err := os.WriteFile(htmlPath, []byte(`<!doctype html><html></html>`), 0o644); err != nil {
		t.Fatalf("seed MAP.html: %v", err)
	}
	st := &state{
		repoRoot:   dir,
		outDir:     dir,
		jsonPath:   jsonPath,
		htmlPath:   htmlPath,
		stdout:     io.Discard,
		stderr:     io.Discard,
		maxClients: 64,
		clients:    make(map[*sseClient]struct{}),
	}
	m := model.NewMap()
	m.Stats.Files = 3
	st.lastMap = m
	return st
}

func get(t *testing.T, srv *httptest.Server, path string) *http.Response {
	t.Helper()
	resp, err := http.Get(srv.URL + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	return resp
}

func TestHandler_ServesMapHTMLOnKnownPaths(t *testing.T) {
	st := newTestState(t)
	srv := httptest.NewServer(st.handler())
	defer srv.Close()

	for _, p := range []string{"/", "/index.html", "/MAP.html"} {
		resp := get(t, srv, p)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("%s: status = %d, want 200", p, resp.StatusCode)
		}
		if ct := resp.Header.Get("content-type"); ct != "text/html; charset=utf-8" {
			t.Errorf("%s: content-type = %q", p, ct)
		}
		if cc := resp.Header.Get("cache-control"); cc != "no-store" {
			t.Errorf("%s: cache-control = %q, want no-store", p, cc)
		}
		body, _ := io.ReadAll(resp.Body)
		if !bytes.Contains(body, []byte("<!doctype html>")) {
			t.Errorf("%s: body = %q", p, body)
		}
	}
}

func TestHandler_ServesMapJSON(t *testing.T) {
	st := newTestState(t)
	srv := httptest.NewServer(st.handler())
	defer srv.Close()

	resp := get(t, srv, "/MAP.json")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("content-type"); ct != "application/json; charset=utf-8" {
		t.Errorf("content-type = %q", ct)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != `{"schemaVersion":5}` {
		t.Errorf("body = %q", body)
	}
}

func TestHandler_MissingFileReturns503(t *testing.T) {
	st := newTestState(t)
	if err := os.Remove(st.htmlPath); err != nil {
		t.Fatalf("remove: %v", err)
	}
	srv := httptest.NewServer(st.handler())
	defer srv.Close()

	resp := get(t, srv, "/MAP.html")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	want := "map-serve: temporarily unavailable, retrying may help (map rebuild in flight)"
	if string(body) != want {
		t.Errorf("body = %q, want %q", body, want)
	}
}

func TestHandler_Health(t *testing.T) {
	st := newTestState(t)
	srv := httptest.NewServer(st.handler())
	defer srv.Close()

	resp := get(t, srv, "/health")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !bytes.Contains(body, []byte(`"ok":true`)) || !bytes.Contains(body, []byte(`"files":3`)) {
		t.Errorf("body = %q", body)
	}
}

func TestHandler_UnknownPathReturns404(t *testing.T) {
	st := newTestState(t)
	srv := httptest.NewServer(st.handler())
	defer srv.Close()

	resp := get(t, srv, "/nope")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "not found" {
		t.Errorf("body = %q, want %q", body, "not found")
	}
}

func TestHandler_EventsCapReturns503BeforeAnyStreamBytes(t *testing.T) {
	st := newTestState(t)
	st.maxClients = 0 // force the cap immediately
	srv := httptest.NewServer(st.handler())
	defer srv.Close()

	resp := get(t, srv, "/events")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "too many live viewers" {
		t.Errorf("body = %q, want %q", body, "too many live viewers")
	}
}

func TestListenWithRetry_BindsBasePortWhenFree(t *testing.T) {
	var stdout, stderr bytes.Buffer
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("find free listener: %v", err)
	}
	freePort := probe.Addr().(*net.TCPAddr).Port
	probe.Close()

	o := Options{Port: freePort, MaxRetries: 3}
	got, port, err := listenWithRetry(o, &stdout, &stderr)
	if err != nil {
		t.Fatalf("listenWithRetry: %v", err)
	}
	defer got.Close()
	if port != freePort {
		t.Errorf("port = %d, want %d", port, freePort)
	}
	if stdout.Len() != 0 {
		t.Errorf("stdout = %q, want empty (no retry needed)", stdout.String())
	}
}

func TestListenWithRetry_PortInUseRetriesAndReportsProgress(t *testing.T) {
	var stdout, stderr bytes.Buffer
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("bind busy listener: %v", err)
	}
	defer busy.Close()
	busyPort := busy.Addr().(*net.TCPAddr).Port

	o := Options{Port: busyPort, MaxRetries: 3}
	got, port, err := listenWithRetry(o, &stdout, &stderr)
	if err != nil {
		t.Fatalf("listenWithRetry: %v", err)
	}
	defer got.Close()
	if port == busyPort {
		t.Errorf("port = %d, want a port other than the busy one", port)
	}
	wantMsg := fmt.Sprintf("port %d is in use, trying %d…\n", busyPort, busyPort+1)
	if stdout.String() != wantMsg {
		t.Errorf("stdout = %q, want %q", stdout.String(), wantMsg)
	}
}
