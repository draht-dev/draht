package serve

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/draht-dev/draht/go/internal/graph"
	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/parse"
	"github.com/draht-dev/draht/go/internal/publication"
	"github.com/draht-dev/draht/go/internal/scan"
)

// pollInterval is how often the watcher re-walks the repo (see watch.go).
const pollInterval = time.Second

func newParser(name string) (parse.Parser, error) {
	switch name {
	case "", "treesitter":
		return parse.NewTreeSitter(parse.CLILangs())
	case "regex":
		return parse.NewRegex(), nil
	default:
		return nil, fmt.Errorf("unknown --parser %q (want treesitter or regex)", name)
	}
}

// sseClient is one open /events connection.
type sseClient struct {
	w        http.ResponseWriter
	fl       http.Flusher
	messages chan string
	stop     chan struct{}
}

// sseClientQueueSize bounds the work a slow viewer can retain. A client that
// falls this far behind is removed rather than delaying every other viewer.
const sseClientQueueSize = 16

// state is map-serve's shared mutable state: the last built map (for
// /health) and the set of live SSE clients (for broadcast).
type state struct {
	repoRoot, outDir, jsonPath, htmlPath string
	parser                               parse.Parser
	stdout, stderr                       io.Writer
	maxClients                           int
	regenFn                              func(context.Context)

	mu      sync.Mutex
	lastMap *model.Map

	clientsMu sync.Mutex
	clients   map[*sseClient]struct{}
}

// build runs the freshness-checked, inter-process coordinated publication and
// records the result for /health.
func (st *state) build(ctx context.Context) (*model.Map, error) {
	m, _, _, err := publication.Build(ctx, graph.Options{
		Root:   st.repoRoot,
		OutDir: st.outDir,
		Parser: st.parser,
	}, false)
	if err != nil {
		return nil, err
	}
	st.mu.Lock()
	st.lastMap = m
	st.mu.Unlock()
	return m, nil
}

func (st *state) broadcast(msg string) {
	st.clientsMu.Lock()
	defer st.clientsMu.Unlock()
	for c := range st.clients {
		select {
		case c.messages <- msg:
		default:
			delete(st.clients, c)
			close(c.stop)
		}
	}
}

func (st *state) removeClient(c *sseClient) {
	st.clientsMu.Lock()
	defer st.clientsMu.Unlock()
	if _, ok := st.clients[c]; ok {
		delete(st.clients, c)
		close(c.stop)
	}
}

func (st *state) startPing(every time.Duration) (stop func()) {
	t := time.NewTicker(every)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-t.C:
				st.broadcast(": ping\n\n")
			case <-done:
				t.Stop()
				return
			}
		}
	}()
	return func() { close(done) }
}

// regen rebuilds the map, prints the timestamped console line (cjs:
// toLocaleTimeString() is locale/TZ-dependent and therefore not
// byte-reproducible; this port uses a fixed HH:MM:SS 24h format instead and
// documents the divergence rather than pretending to match it), and
// broadcasts "data: changed" to every live SSE client.
func (st *state) regen(ctx context.Context) {
	m, err := st.build(ctx)
	if err != nil {
		fmt.Fprintln(st.stderr, "regen failed:", err)
		return
	}
	ts := time.Now().Format("15:04:05")
	fmt.Fprintf(st.stdout, "[%s] regenerated MAP.json (%d modules, %dms)\n", ts, m.Stats.Files, m.BuildMs)
	st.broadcast("data: changed\n\n")
}

func (st *state) runRegen(ctx context.Context) {
	if st.regenFn != nil {
		st.regenFn(ctx)
		return
	}
	st.regen(ctx)
}

// debouncedRegen returns a callback the watcher invokes on every detected
// change. Calls inside `debounce` coalesce, and regeneration is single-flight:
// if the debounce expires during a build, exactly one latest follow-up runs
// after it. This prevents concurrent builders from publishing out of order.
func (st *state) debouncedRegen(ctx context.Context, debounce time.Duration) func() {
	var mu sync.Mutex
	var timer *time.Timer
	var generation uint64
	var running, pending bool

	fire := func(firedGeneration uint64) {
		mu.Lock()
		if firedGeneration != generation {
			mu.Unlock()
			return
		}
		if running {
			pending = true
			mu.Unlock()
			return
		}
		running = true
		mu.Unlock()

		for {
			st.runRegen(ctx)
			mu.Lock()
			if !pending {
				running = false
				mu.Unlock()
				return
			}
			pending = false
			mu.Unlock()
		}
	}

	return func() {
		mu.Lock()
		defer mu.Unlock()
		generation++
		thisGeneration := generation
		if timer != nil {
			timer.Stop()
		}
		timer = time.AfterFunc(debounce, func() { fire(thisGeneration) })
	}
}

func (st *state) serveFile(w http.ResponseWriter, path, contentType string) {
	data, err := os.ReadFile(path)
	if err != nil {
		w.Header().Set("content-type", "text/plain")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("map-serve: temporarily unavailable, retrying may help (map rebuild in flight)"))
		return
	}
	w.Header().Set("content-type", contentType)
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

type healthResponse struct {
	OK    bool         `json:"ok"`
	Stats *model.Stats `json:"stats"`
}

func (st *state) handleHealth(w http.ResponseWriter) {
	st.mu.Lock()
	m := st.lastMap
	st.mu.Unlock()
	var stats *model.Stats
	if m != nil {
		stats = &m.Stats
	}
	b, err := json.Marshal(healthResponse{OK: true, Stats: stats})
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(b)
}

func (st *state) handleEvents(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	c := &sseClient{
		w:        w,
		fl:       fl,
		messages: make(chan string, sseClientQueueSize),
		stop:     make(chan struct{}),
	}

	// Admission and registration are one operation: no concurrent request can
	// observe a free slot that another request has already claimed.
	st.clientsMu.Lock()
	if len(st.clients) >= st.maxClients {
		st.clientsMu.Unlock()
		// Must be a non-200 BEFORE any event-stream bytes (cjs comment,
		// preserved): a cleanly closed 200 stream makes EventSource
		// reconnect forever; a 503 fails the connection permanently.
		w.Header().Set("content-type", "text/plain")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("too many live viewers"))
		return
	}
	st.clients[c] = struct{}{}
	st.clientsMu.Unlock()
	defer st.removeClient(c)

	w.Header().Set("content-type", "text/event-stream")
	w.Header().Set("cache-control", "no-cache")
	w.Header().Set("connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, "retry: 2000\n\n")
	fl.Flush()

	for {
		select {
		case msg := <-c.messages:
			fmt.Fprint(c.w, msg)
			c.fl.Flush()
		case <-c.stop:
			return
		case <-r.Context().Done():
			return
		}
	}
}

func (st *state) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/", "/index.html", "/MAP.html":
			st.serveFile(w, st.htmlPath, "text/html; charset=utf-8")
		case "/MAP.json":
			st.serveFile(w, st.jsonPath, "application/json; charset=utf-8")
		case "/events":
			st.handleEvents(w, r)
		case "/health":
			st.handleHealth(w)
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte("not found"))
		}
	})
}

var errAllPortsBusy = errors.New("serve: all candidate ports busy")

func isAddrInUse(err error) bool {
	return err != nil && strings.Contains(err.Error(), "address already in use")
}

// listenWithRetry ports the tryListen(port, 10) recursion (cjs:5285-5303)
// iteratively: try basePort, then basePort+1 .. basePort+MaxRetries,
// printing the same progress/failure messages.
func listenWithRetry(o Options, stdout, stderr io.Writer) (net.Listener, int, error) {
	basePort := o.Port
	for attempt := 0; attempt <= o.MaxRetries; attempt++ {
		candidate := basePort + attempt
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", candidate))
		if err == nil {
			return ln, candidate, nil
		}
		if !isAddrInUse(err) {
			fmt.Fprintln(stderr, "map-serve: failed to start:", err)
			return nil, 0, err
		}
		if attempt < o.MaxRetries {
			fmt.Fprintf(stdout, "port %d is in use, trying %d…\n", candidate, candidate+1)
		} else {
			fmt.Fprintf(stderr, "map-serve: ports %d-%d are all in use. Pass --port <n> to pick a free one.\n", basePort, basePort+o.MaxRetries)
		}
	}
	return nil, 0, errAllPortsBusy
}

func openURL(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start() // errors swallowed, matching the CJS's execSync try/catch
}

// Run builds the map once, starts the watcher, binds 127.0.0.1:Port with
// EADDRINUSE retry, and blocks until ctx is done. It returns the process
// exit code (0 on a clean shutdown, 1 if the server never managed to
// start).
func Run(ctx context.Context, repoRoot string, o Options, stdout, stderr io.Writer) int {
	outDir := scan.GraphOutDir(repoRoot)

	// Must come from langset, never a hand-written slice: map-serve shares the
	// on-disk extraction cache with map-graph, and the enabled grammar set is
	// part of the cache key. A drifted list here would mean two binaries
	// writing entries under keys that disagree about which languages were
	// parsed. (cmd/draht-tools/mapgraph.go states the same rule for the CLI.)
	parser, err := newParser(o.ParserName)
	if err != nil {
		fmt.Fprintln(stderr, "map-serve: failed to start:", err)
		return 1
	}
	defer parser.Close()

	st := &state{
		repoRoot:   repoRoot,
		outDir:     outDir,
		jsonPath:   filepath.Join(outDir, "MAP.json"),
		htmlPath:   filepath.Join(outDir, "MAP.html"),
		parser:     parser,
		stdout:     stdout,
		stderr:     stderr,
		maxClients: o.MaxClients,
		clients:    make(map[*sseClient]struct{}),
	}

	m, err := st.build(ctx)
	if err != nil {
		fmt.Fprintln(stderr, "map-serve: failed to start:", err)
		return 1
	}

	fmt.Fprintln(stdout, strings.Repeat("━", 55))
	fmt.Fprintln(stdout, " DRAHT ► MAP-SERVE")
	fmt.Fprintln(stdout, strings.Repeat("━", 55))
	rel, relErr := filepath.Rel(repoRoot, outDir)
	if relErr != nil {
		rel = outDir
	}
	fmt.Fprintf(stdout, "\nServing %s/\n", rel)
	fmt.Fprintf(stdout, "Indexed %d modules in %dms\n", m.Stats.Files, m.BuildMs)

	ln, boundPort, err := listenWithRetry(o, stdout, stderr)
	if err != nil {
		return 1
	}
	if boundPort != o.Port {
		fmt.Fprintf(stdout, "(port %d was busy — bound to %d instead)\n", o.Port, boundPort)
	}
	fmt.Fprintf(stdout, "\n→ Open http://localhost:%d\n", boundPort)
	fmt.Fprintln(stdout, "  Live updates via SSE; edits to source files regenerate the map.")
	fmt.Fprintln(stdout, "  Ctrl-C to stop.")

	if o.OpenBrowser {
		openURL(fmt.Sprintf("http://localhost:%d", boundPort))
	}

	httpSrv := &http.Server{Handler: st.handler()}
	serveErrCh := make(chan error, 1)
	go func() { serveErrCh <- httpSrv.Serve(ln) }()

	stopPing := st.startPing(o.PingEvery)
	defer stopPing()

	watchCtx, cancelWatch := context.WithCancel(ctx)
	defer cancelWatch()
	if !startPollWatcher(watchCtx, repoRoot, pollInterval, st.debouncedRegen(watchCtx, o.Debounce)) {
		fmt.Fprintln(stderr, "map-serve: file watching unavailable — live reload disabled (use the reload button).")
	}

	select {
	case <-ctx.Done():
	case serveErr := <-serveErrCh:
		if serveErr != nil && serveErr != http.ErrServerClosed {
			fmt.Fprintln(stderr, "map-serve: failed to start:", serveErr)
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdownCtx)
	return 0
}
