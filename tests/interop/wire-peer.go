// A loopback WebSocket peer controlled over HTTP by wire fixture runners.
// Run from servers/go to use the existing websocket dependency.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

type connection struct {
	ws     *websocket.Conn
	frames chan json.RawMessage
	done   chan struct{}
}

func main() {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	var mu sync.Mutex
	connections := make(map[string]*connection)
	accepted := make(chan string, 64)
	nextID := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer ws.CloseNow()
		ws.SetReadLimit(256 << 10)
		c := &connection{ws: ws, frames: make(chan json.RawMessage, 128), done: make(chan struct{})}
		mu.Lock()
		nextID++
		id := strconv.Itoa(nextID)
		connections[id] = c
		mu.Unlock()
		defer func() {
			close(c.done)
			mu.Lock()
			delete(connections, id)
			mu.Unlock()
		}()
		select {
		case accepted <- id:
		case <-r.Context().Done():
			return
		}
		for {
			kind, frame, err := ws.Read(r.Context())
			if err != nil || kind != websocket.MessageText {
				return
			}
			select {
			case c.frames <- json.RawMessage(frame):
			case <-r.Context().Done():
				return
			}
		}
	})
	mux.HandleFunc("GET /next", func(w http.ResponseWriter, r *http.Request) {
		select {
		case id := <-accepted:
			_ = json.NewEncoder(w).Encode(id)
		case <-r.Context().Done():
		}
	})
	mux.HandleFunc("POST /connections/{id}/{action}", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		c := connections[r.PathValue("id")]
		mu.Unlock()
		if c == nil {
			http.NotFound(w, r)
			return
		}
		switch r.PathValue("action") {
		case "send":
			var frame json.RawMessage
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&frame); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			if err := c.ws.Write(r.Context(), websocket.MessageText, frame); err != nil {
				http.Error(w, err.Error(), http.StatusGone)
			}
		case "receive":
			select {
			case frame := <-c.frames:
				_, _ = w.Write(frame)
			case <-c.done:
				http.Error(w, "connection closed", http.StatusGone)
			case <-r.Context().Done():
			}
		case "close":
			_ = c.ws.CloseNow()
		default:
			http.NotFound(w, r)
		}
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = server.Serve(listener) }()
	fmt.Println("http://" + listener.Addr().String())
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	mu.Lock()
	active := make([]*connection, 0, len(connections))
	for _, c := range connections {
		active = append(active, c)
	}
	mu.Unlock()
	for _, c := range active {
		_ = c.ws.CloseNow()
	}
	shutdown, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = server.Shutdown(shutdown)
}
