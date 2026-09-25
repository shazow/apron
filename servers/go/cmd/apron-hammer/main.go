// Command apron-hammer load-tests an Apron server, reporting
// throughput, latency, and (with aprond's -debug-addr) the server's heap and
// goroutines across each scenario. See README.md in this directory.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type hammer struct {
	wsURL    string
	httpURL  string
	origin   string
	clients  int
	duration time.Duration
	bodySize int
	verbose  bool

	dials             atomic.Int64
	framesIn          atomic.Int64
	bytesIn           atomic.Int64
	framesOut         atomic.Int64
	bytesOut          atomic.Int64
	serverDisconnects atomic.Int64
	violations        atomic.Int64
	violationMu       sync.Mutex
	violationSamples  []string
}

func (h *hammer) protocolViolation(format string, args ...any) {
	h.violations.Add(1)
	h.violationMu.Lock()
	defer h.violationMu.Unlock()
	if len(h.violationSamples) < 10 {
		h.violationSamples = append(h.violationSamples, fmt.Sprintf(format, args...))
	}
}

type scenario struct {
	name        string
	description string
	// run sets up what it needs, then calls st.window for the measured phase.
	run func(h *hammer, st *stats)
}

var scenarios = []scenario{
	{"churn", "connect, sign in as a guest, and disconnect as fast as possible", runChurn},
	{"flood", "every client posts to general with one request in flight", runFlood},
	{"activity", "every client sends typing activity to general", runActivity},
	{"slow", "slow consumers that stop reading while others keep posting", runSlow},
	{"history", "seed a room, then page its history concurrently", runHistory},
	{"threads", "create many threads, then list them, sign in, list joined rooms, and join concurrently", runThreads},
	{"edits", "post, edit, react, and delete in a loop", runEdits},
	{"embeds", "upload files and run live streams with readers", runEmbeds},
}

func main() {
	h := &hammer{}
	server := flag.String("server", "127.0.0.1:8080", "server host:port")
	flag.StringVar(&h.origin, "origin", "", "Origin header to send; empty sends none")
	debug := flag.String("debug", "http://127.0.0.1:6060", "aprond -debug-addr base URL; empty disables server monitoring")
	selected := flag.String("scenarios", "all", "comma-separated scenarios to run, or all")
	flag.IntVar(&h.clients, "clients", 50, "concurrent clients per scenario")
	flag.DurationVar(&h.duration, "duration", 10*time.Second, "how long each scenario runs")
	flag.IntVar(&h.bodySize, "body-bytes", 200, "message text size for flood")
	profileDir := flag.String("profile-dir", "", "save CPU, heap, and allocs profiles of each scenario here")
	flag.BoolVar(&h.verbose, "v", false, "print a server sample every second")
	list := flag.Bool("list", false, "list scenarios and exit")
	flag.Parse()

	if *list {
		for _, s := range scenarios {
			fmt.Printf("%-10s %s\n", s.name, s.description)
		}
		return
	}
	h.wsURL = "ws://" + *server + "/ws"
	h.httpURL = "http://" + *server

	var run []scenario
	if *selected == "all" {
		run = scenarios
	} else {
		for _, name := range strings.Split(*selected, ",") {
			i := slices.IndexFunc(scenarios, func(s scenario) bool { return s.name == strings.TrimSpace(name) })
			if i < 0 {
				fmt.Fprintf(os.Stderr, "unknown scenario %q (use -list)\n", name)
				os.Exit(2)
			}
			run = append(run, scenarios[i])
		}
	}
	if *profileDir != "" {
		if err := os.MkdirAll(*profileDir, 0o755); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	mon := newMonitor(*debug, *profileDir)

	failed := false
	for _, s := range run {
		if !runScenario(h, mon, s) {
			failed = true
		}
	}
	if failed {
		os.Exit(1)
	}
}

// runScenario runs one scenario between two settled server samples and
// reports it. It returns false when the server stopped answering.
func runScenario(h *hammer, mon *monitor, s scenario) bool {
	fmt.Printf("\n== %s: %s (%d clients, %s)\n", s.name, s.description, h.clients, h.duration)
	var before memSample
	if mon.enabled() {
		var err error
		if before, err = mon.settled(); err != nil {
			fmt.Printf("   !! server debug endpoint: %v\n", err)
			return false
		}
		if mon.dir != "" {
			mon.saveProfile("allocs", s.name+".allocs-before.pprof")
		}
	}
	h.resetCounters()
	st := newStats(h)
	watchCtx, stopWatch := context.WithCancel(context.Background())
	var watching sync.WaitGroup
	var cpuDone <-chan struct{}
	if mon.enabled() {
		watching.Go(func() { mon.watch(watchCtx, time.Second, h.verbose, s.name) })
		if mon.dir != "" {
			cpuDone = mon.profileCPU(h.duration, s.name+".cpu.pprof")
		}
	}

	s.run(h, st)
	elapsed := st.elapsed()
	stopWatch()
	watching.Wait()
	if cpuDone != nil {
		<-cpuDone
	}

	st.report(elapsed)
	fmt.Printf("   frames in=%d (%.0f/s, %s)  out=%d (%s)  dials=%d  server disconnects=%d\n",
		h.framesIn.Load(), float64(h.framesIn.Load())/elapsed.Seconds(), mib(uint64(h.bytesIn.Load())),
		h.framesOut.Load(), mib(uint64(h.bytesOut.Load())), h.dials.Load(), h.serverDisconnects.Load())
	if n := h.violations.Load(); n > 0 {
		fmt.Printf("   !! %d protocol violations, e.g. %q\n", n, h.violationSamples)
	}
	if !mon.enabled() {
		return true
	}
	peak, peakG := mon.peaks()
	if mon.dir != "" {
		mon.saveProfile("heap", s.name+".heap.pprof")
		mon.saveProfile("allocs", s.name+".allocs.pprof")
		mon.saveProfile("goroutine", s.name+".goroutine.pprof")
	}
	// Give the server a moment to notice closed connections before measuring
	// what it retains.
	settleStart := time.Now()
	// It has settled once its goroutines are back and a forced collection
	// no longer frees anything.
	var after memSample
	var err error
	for previous := uint64(0); ; previous = after.HeapAlloc {
		time.Sleep(250 * time.Millisecond)
		if after, err = mon.settled(); err != nil {
			break
		}
		stable := previous != 0 && after.HeapAlloc >= previous*99/100
		if after.goroutines <= before.goroutines && stable {
			break
		}
		if time.Since(settleStart) > 10*time.Second {
			break
		}
	}
	if err != nil {
		fmt.Printf("   !! SERVER DOWN after scenario: %v\n", err)
		return false
	}
	fmt.Printf("   server heap: before=%s peak=%s retained=%s (%+.1fMiB, %+d objects)  sys=%s\n",
		mib(before.HeapAlloc), mib(peak.HeapAlloc), mib(after.HeapAlloc),
		(float64(after.HeapAlloc)-float64(before.HeapAlloc))/(1<<20), int64(after.HeapObjects)-int64(before.HeapObjects), mib(after.Sys))
	fmt.Printf("   server allocs: %s in %d mallocs (%.0f/s), %d GCs, %.1fms GC pause\n",
		mib(after.TotalAlloc-before.TotalAlloc), after.Mallocs-before.Mallocs,
		float64(after.Mallocs-before.Mallocs)/elapsed.Seconds(), after.NumGC-before.NumGC,
		float64(after.PauseTotalNs-before.PauseTotalNs)/1e6)
	leak := ""
	if after.goroutines > before.goroutines {
		leak = "  !! goroutines not released"
	}
	fmt.Printf("   server goroutines: before=%d peak=%d after=%d%s\n", before.goroutines, peakG, after.goroutines, leak)
	return true
}

func (h *hammer) resetCounters() {
	for _, c := range []*atomic.Int64{&h.dials, &h.framesIn, &h.bytesIn, &h.framesOut, &h.bytesOut, &h.serverDisconnects, &h.violations} {
		c.Store(0)
	}
	h.violationMu.Lock()
	h.violationSamples = nil
	h.violationMu.Unlock()
}

// stats collects per-operation latencies and errors for one scenario.
type stats struct {
	h      *hammer
	start  time.Time
	end    time.Time
	mu     sync.Mutex
	series map[string]*series
	order  []string
	notes  []string
}

type series struct {
	latencies []time.Duration
	errors    map[string]int
	errCount  int
}

func newStats(h *hammer) *stats {
	return &stats{h: h, series: make(map[string]*series), start: time.Now()}
}

// window starts the measured phase: rates count from here, and frame
// counters restart. It returns a context that ends after the duration.
func (st *stats) window() (context.Context, context.CancelFunc) {
	st.h.resetCounters()
	st.mu.Lock()
	for _, s := range st.series {
		s.latencies, s.errors, s.errCount = nil, make(map[string]int), 0
	}
	st.start = time.Now()
	st.mu.Unlock()
	return context.WithTimeout(context.Background(), st.h.duration)
}

// finish ends the measured phase.
func (st *stats) finish() {
	st.mu.Lock()
	st.end = time.Now()
	st.mu.Unlock()
}

func (st *stats) elapsed() time.Duration {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.end.IsZero() {
		st.end = time.Now()
	}
	return st.end.Sub(st.start)
}

func (st *stats) get(op string) *series {
	s := st.series[op]
	if s == nil {
		s = &series{errors: make(map[string]int)}
		st.series[op] = s
		st.order = append(st.order, op)
	}
	return s
}

// observe records one operation: its latency on success, or its error.
func (st *stats) observe(op string, d time.Duration, err error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	s := st.get(op)
	if err != nil {
		s.errCount++
		key := err.Error()
		if len(key) > 90 {
			key = key[:90] + "…"
		}
		if len(s.errors) < 8 || s.errors[key] > 0 {
			s.errors[key]++
		}
		return
	}
	s.latencies = append(s.latencies, d)
}

// time runs f and records it under op.
func (st *stats) time(op string, f func() error) error {
	start := time.Now()
	err := f()
	st.observe(op, time.Since(start), err)
	return err
}

func (st *stats) note(format string, args ...any) {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.notes = append(st.notes, fmt.Sprintf(format, args...))
}

func (st *stats) report(elapsed time.Duration) {
	st.mu.Lock()
	defer st.mu.Unlock()
	for _, op := range st.order {
		s := st.series[op]
		slices.Sort(s.latencies)
		n := len(s.latencies)
		line := fmt.Sprintf("   %-18s ok=%-8d err=%-6d rate=%8.0f/s", op, n, s.errCount, float64(n)/elapsed.Seconds())
		if n > 0 {
			q := func(p float64) time.Duration { return s.latencies[min(n-1, int(p*float64(n)))] }
			line += fmt.Sprintf("  p50=%-9s p95=%-9s p99=%-9s max=%s", round(q(0.5)), round(q(0.95)), round(q(0.99)), round(s.latencies[n-1]))
		}
		fmt.Println(line)
		for key, count := range s.errors {
			fmt.Printf("      %6d × %s\n", count, key)
		}
	}
	for _, note := range st.notes {
		fmt.Printf("   • %s\n", note)
	}
}

func round(d time.Duration) time.Duration {
	switch {
	case d > time.Second:
		return d.Round(10 * time.Millisecond)
	case d > time.Millisecond:
		return d.Round(10 * time.Microsecond)
	default:
		return d.Round(time.Microsecond)
	}
}
