package serve

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/draht-dev/draht/go/internal/model"
)

func TestDebouncedRegen_SerializesBuildsAndRunsLatestGeneration(t *testing.T) {
	var active, maxActive, calls atomic.Int32
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	secondDone := make(chan struct{})
	st := &state{
		regenFn: func(context.Context) {
			n := active.Add(1)
			for {
				max := maxActive.Load()
				if n <= max || maxActive.CompareAndSwap(max, n) {
					break
				}
			}
			call := calls.Add(1)
			if call == 1 {
				close(firstStarted)
				<-releaseFirst
			}
			active.Add(-1)
			if call == 2 {
				close(secondDone)
			}
		},
	}

	trigger := st.debouncedRegen(context.Background(), time.Millisecond)
	trigger()
	select {
	case <-firstStarted:
	case <-time.After(time.Second):
		t.Fatal("first regeneration did not start")
	}

	// Changes arriving during the build coalesce to one latest follow-up.
	trigger()
	trigger()
	trigger()
	time.Sleep(10 * time.Millisecond)
	if got := calls.Load(); got != 1 {
		t.Fatalf("calls while first build is blocked = %d, want 1", got)
	}
	close(releaseFirst)

	select {
	case <-secondDone:
	case <-time.After(time.Second):
		t.Fatal("latest regeneration did not run")
	}
	time.Sleep(10 * time.Millisecond)
	if got := maxActive.Load(); got != 1 {
		t.Errorf("maximum concurrent regenerations = %d, want 1", got)
	}
	if got := calls.Load(); got != 2 {
		t.Errorf("regeneration calls = %d, want 2 (initial plus one latest)", got)
	}
}

func TestNewParser_SelectsRegex(t *testing.T) {
	p, err := newParser("regex")
	if err != nil {
		t.Fatalf("newParser(regex): %v", err)
	}
	defer p.Close()
	if got := p.Version(); got != "re/1" {
		t.Errorf("Version = %q, want re/1", got)
	}
}

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

type gatedResponseWriter struct {
	mu      sync.Mutex
	header  http.Header
	status  int
	arrived chan<- struct{}
	release <-chan struct{}
}

func (w *gatedResponseWriter) Header() http.Header { return w.header }
func (w *gatedResponseWriter) WriteHeader(status int) {
	w.mu.Lock()
	w.status = status
	w.mu.Unlock()
	w.arrived <- struct{}{}
	<-w.release
}
func (w *gatedResponseWriter) Write(p []byte) (int, error) { return len(p), nil }
func (w *gatedResponseWriter) Flush()                      {}
func (w *gatedResponseWriter) Status() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.status
}

func TestHandler_EventsSimultaneousRequestsCannotExceedCap(t *testing.T) {
	const requests = 12
	st := newTestState(t)
	st.maxClients = 1
	arrived := make(chan struct{}, requests)
	release := make(chan struct{})
	writers := make([]*gatedResponseWriter, requests)
	cancels := make([]context.CancelFunc, requests)
	done := make(chan struct{}, requests)

	for i := range requests {
		writers[i] = &gatedResponseWriter{header: make(http.Header), arrived: arrived, release: release}
		ctx, cancel := context.WithCancel(context.Background())
		cancels[i] = cancel
		req := httptest.NewRequest(http.MethodGet, "/events", nil).WithContext(ctx)
		go func(w http.ResponseWriter) {
			st.handleEvents(w, req)
			done <- struct{}{}
		}(writers[i])
	}

	for range requests {
		select {
		case <-arrived:
		case <-time.After(time.Second):
			t.Fatal("concurrent requests did not all reach admission response")
		}
	}
	close(release)

	accepted := 0
	for _, w := range writers {
		if w.Status() == http.StatusOK {
			accepted++
		}
	}
	if accepted != st.maxClients {
		t.Errorf("simultaneous accepted clients = %d, want cap %d", accepted, st.maxClients)
	}

	for _, cancel := range cancels {
		cancel()
	}
	for range requests {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("event handler did not exit after cancellation")
		}
	}
}

type blockingEventWriter struct {
	header       http.Header
	eventStarted chan<- struct{}
	unblock      <-chan struct{}
	writes       atomic.Int32
}

func (w *blockingEventWriter) Header() http.Header { return w.header }
func (w *blockingEventWriter) WriteHeader(int)     {}
func (w *blockingEventWriter) Flush()              {}
func (w *blockingEventWriter) Write(p []byte) (int, error) {
	if w.writes.Add(1) > 1 {
		select {
		case w.eventStarted <- struct{}{}:
		default:
		}
		<-w.unblock
	}
	return len(p), nil
}

type observingEventWriter struct {
	header http.Header
	event  chan<- struct{}
	writes atomic.Int32
}

func (w *observingEventWriter) Header() http.Header { return w.header }
func (w *observingEventWriter) WriteHeader(int)     {}
func (w *observingEventWriter) Flush()              {}
func (w *observingEventWriter) Write(p []byte) (int, error) {
	if w.writes.Add(1) > 1 && w.event != nil {
		select {
		case w.event <- struct{}{}:
		default:
		}
	}
	return len(p), nil
}

func TestBroadcast_StalledClientDoesNotBlockOthersOrAdmission(t *testing.T) {
	st := newTestState(t)
	st.maxClients = 3
	stalled := make(chan struct{}, 1)
	unblock := make(chan struct{})
	delivered := make(chan struct{}, 1)
	blockedWriter := &blockingEventWriter{header: make(http.Header), eventStarted: stalled, unblock: unblock}
	fastWriter := &observingEventWriter{header: make(http.Header), event: delivered}
	ctx1, cancel1 := context.WithCancel(context.Background())
	ctx2, cancel2 := context.WithCancel(context.Background())
	done := make(chan struct{}, 3)
	go func() {
		st.handleEvents(blockedWriter, httptest.NewRequest(http.MethodGet, "/events", nil).WithContext(ctx1))
		done <- struct{}{}
	}()
	go func() {
		st.handleEvents(fastWriter, httptest.NewRequest(http.MethodGet, "/events", nil).WithContext(ctx2))
		done <- struct{}{}
	}()

	deadline := time.Now().Add(time.Second)
	for {
		st.clientsMu.Lock()
		clients := len(st.clients)
		st.clientsMu.Unlock()
		if clients == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("initial event clients were not registered")
		}
		time.Sleep(time.Millisecond)
	}

	broadcastDone := make(chan struct{})
	go func() {
		st.broadcast("data: changed\n\n")
		close(broadcastDone)
	}()
	select {
	case <-stalled:
	case <-time.After(time.Second):
		t.Fatal("stalled client did not receive broadcast")
	}
	select {
	case <-delivered:
	case <-time.After(time.Second):
		t.Error("responsive client was blocked by stalled client")
	}

	thirdWriter := &observingEventWriter{header: make(http.Header)}
	ctx3, cancel3 := context.WithCancel(context.Background())
	go func() {
		st.handleEvents(thirdWriter, httptest.NewRequest(http.MethodGet, "/events", nil).WithContext(ctx3))
		done <- struct{}{}
	}()
	deadline = time.Now().Add(200 * time.Millisecond)
	for thirdWriter.writes.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if thirdWriter.writes.Load() == 0 {
		t.Error("admission was blocked by stalled client")
	}
	select {
	case <-broadcastDone:
	case <-time.After(200 * time.Millisecond):
		t.Error("broadcast remained blocked on stalled client")
	}

	close(unblock)
	cancel1()
	cancel2()
	cancel3()
	for range 3 {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("event handler did not exit during cleanup")
		}
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
