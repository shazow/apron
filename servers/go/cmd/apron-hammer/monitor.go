package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// memSample is the server's runtime state, read from aprond's -debug-addr
// listener (expvar memstats and the goroutine profile).
type memSample struct {
	HeapAlloc    uint64 `json:"HeapAlloc"`
	HeapInuse    uint64 `json:"HeapInuse"`
	HeapObjects  uint64 `json:"HeapObjects"`
	Sys          uint64 `json:"Sys"`
	TotalAlloc   uint64 `json:"TotalAlloc"`
	Mallocs      uint64 `json:"Mallocs"`
	NumGC        uint32 `json:"NumGC"`
	PauseTotalNs uint64 `json:"PauseTotalNs"`
	goroutines   int
}

type monitor struct {
	base   string
	client *http.Client
	dir    string

	mu    sync.Mutex
	peak  memSample
	peakG int
	last  memSample
	down  bool
}

func newMonitor(base, dir string) *monitor {
	return &monitor{base: strings.TrimRight(base, "/"), dir: dir, client: &http.Client{Timeout: 30 * time.Second}}
}

func (m *monitor) enabled() bool { return m.base != "" }

func (m *monitor) get(path string) ([]byte, error) {
	response, err := m.client.Get(m.base + path)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: %s", path, response.Status)
	}
	return io.ReadAll(response.Body)
}

func (m *monitor) sample() (memSample, error) {
	var vars struct {
		Memstats memSample `json:"memstats"`
	}
	raw, err := m.get("/debug/vars")
	if err != nil {
		return memSample{}, err
	}
	if err := json.Unmarshal(raw, &vars); err != nil {
		return memSample{}, err
	}
	s := vars.Memstats
	goroutines, err := m.get("/debug/pprof/goroutine?debug=1")
	if err != nil {
		return memSample{}, err
	}
	line, _ := bufio.NewReader(strings.NewReader(string(goroutines))).ReadString('\n')
	_, _ = fmt.Sscanf(line, "goroutine profile: total %d", &s.goroutines)
	return s, nil
}

// settled forces a collection (the heap profile's gc=1) and then samples, so
// HeapAlloc is what the server retains rather than garbage awaiting GC.
func (m *monitor) settled() (memSample, error) {
	if _, err := m.get("/debug/pprof/heap?gc=1"); err != nil {
		return memSample{}, err
	}
	return m.sample()
}

// watch samples every interval until ctx ends, tracking the peaks.
func (m *monitor) watch(ctx context.Context, interval time.Duration, verbose bool, label string) {
	m.mu.Lock()
	m.peak, m.peakG = memSample{}, 0
	m.mu.Unlock()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	start := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		s, err := m.sample()
		m.mu.Lock()
		if err != nil {
			if !m.down {
				fmt.Fprintf(os.Stderr, "  !! debug endpoint unreachable: %v\n", err)
			}
			m.down = true
			m.mu.Unlock()
			continue
		}
		m.down = false
		m.last = s
		if s.HeapAlloc > m.peak.HeapAlloc {
			m.peak = s
		}
		m.peakG = max(m.peakG, s.goroutines)
		m.mu.Unlock()
		if verbose {
			fmt.Fprintf(os.Stderr, "  [%s %5.1fs] heap=%s inuse=%s sys=%s objects=%d goroutines=%d gc=%d\n",
				label, time.Since(start).Seconds(), mib(s.HeapAlloc), mib(s.HeapInuse), mib(s.Sys), s.HeapObjects, s.goroutines, s.NumGC)
		}
	}
}

func (m *monitor) peaks() (memSample, int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.peak, m.peakG
}

// profileCPU records a CPU profile of the next d into dir.
func (m *monitor) profileCPU(d time.Duration, name string) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		seconds := max(1, int(d/time.Second))
		// No keep-alive, so the profile's connection is gone before the
		// goroutine count after the scenario.
		client := &http.Client{Timeout: d + 30*time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
		response, err := client.Get(fmt.Sprintf("%s/debug/pprof/profile?seconds=%d", m.base, seconds))
		if err != nil {
			fmt.Fprintf(os.Stderr, "  cpu profile: %v\n", err)
			return
		}
		defer response.Body.Close()
		m.save(name, response.Body)
	}()
	return done
}

// saveProfile stores a named pprof profile (heap, allocs, goroutine, ...).
func (m *monitor) saveProfile(profile, name string) {
	raw, err := m.get("/debug/pprof/" + profile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "  %s profile: %v\n", profile, err)
		return
	}
	m.save(name, strings.NewReader(string(raw)))
}

func (m *monitor) save(name string, r io.Reader) {
	path := filepath.Join(m.dir, name)
	f, err := os.Create(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "  save %s: %v\n", path, err)
		return
	}
	defer f.Close()
	_, _ = io.Copy(f, r)
}

func mib(n uint64) string {
	return fmt.Sprintf("%.1fMiB", float64(n)/(1<<20))
}
