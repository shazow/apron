package main

import (
	"context"
	"expvar"
	"flag"
	"log/slog"
	"net"
	"net/http"
	"net/http/pprof"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/shazow/apron/servers/go/internal/server"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "HTTP and WebSocket listen address; use :8080 to listen on every interface")
	staticDir := flag.String("static-dir", "", "directory containing the built frontend")
	origins := flag.String("origin", "", "comma-separated allowed WebSocket origins; empty uses localhost defaults")
	allowAnyOrigin := flag.Bool("allow-any-origin", false, "disable WebSocket origin checks")
	rpID := flag.String("webauthn-rp-id", "localhost", "passkey relying party domain; empty disables passkeys")
	rpOrigins := flag.String("webauthn-origin", "http://localhost:5173,http://localhost:8080", "comma-separated exact frontend origins for passkeys")
	publicURL := flag.String("public-url", "", "external base URL of upload, file, and stream links, such as https://chat.example; empty uses each request's host")
	maxConnections := flag.Int("max-connections", 0, "maximum concurrent WebSockets; 0 is unlimited")
	messagesPerMinute := flag.Int("messages-per-minute", 0, "maximum new messages, room_set requests, and /avatar commands per user per minute; 0 is unlimited")
	uploadDir := flag.String("upload-dir", defaultUploadDir(), "directory holding uploaded files; upload files left by a previous run are removed at start")
	maxUploadMiB := flag.Int64("max-upload-mb", 20, "maximum size of one upload, in MiB")
	maxMessageUploadMiB := flag.Int64("max-message-upload-mb", 20, "maximum total size of one message's uploads, in MiB")
	maxUploadStorageMiB := flag.Int64("max-upload-storage-mb", 1000, "total size of hosted uploads, in MiB, beyond which the oldest are removed from their messages")
	disablePush := flag.Bool("disable-push", false, "do not offer push registration")
	allowInsecurePush := flag.Bool("allow-insecure-push", false, "accept http and internal push endpoints (development only)")
	debugAddr := flag.String("debug-addr", "", "listen address for pprof and expvar under /debug/, such as 127.0.0.1:6060; empty disables")
	flag.Parse()

	config := server.DefaultConfig()
	config.StaticDir = *staticDir
	config.AllowAnyOrigin = *allowAnyOrigin
	config.PublicURL = *publicURL
	config.MaxConnections = *maxConnections
	config.MessagesPerMinute = *messagesPerMinute
	config.UploadDir = *uploadDir
	config.MaxUploadBytes = *maxUploadMiB << 20
	config.MaxMessageUploadBytes = *maxMessageUploadMiB << 20
	config.MaxUploadStorageBytes = *maxUploadStorageMiB << 20
	config.DisablePush = *disablePush
	config.AllowInsecurePush = *allowInsecurePush
	if strings.TrimSpace(*origins) != "" {
		config.OriginPatterns = splitNonEmpty(*origins)
	}
	if *rpID != "" {
		var err error
		config.WebAuthn, err = webauthn.New(&webauthn.Config{
			RPID: *rpID, RPDisplayName: "Apron", RPOrigins: splitNonEmpty(*rpOrigins),
		})
		if err != nil {
			slog.Error("invalid WebAuthn configuration", "error", err)
			os.Exit(1)
		}
	}

	app := server.New(config)
	httpServer := &http.Server{
		Addr:              *addr,
		Handler:           app.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		// Idle keep-alive connections close; WebSockets and streams are
		// hijacked or long-lived requests, which it does not affect.
		IdleTimeout: 2 * time.Minute,
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if *debugAddr != "" {
		if !loopbackAddr(*debugAddr) {
			logger.Warn("the debug listener is unauthenticated and not bound to loopback", "addr", *debugAddr)
		}
		go serveDebug(logger, *debugAddr)
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(stop)

	serverErr := make(chan error, 1)
	go func() {
		logger.Info("apron server listening", "addr", *addr, "static_dir", *staticDir, "upload_dir", *uploadDir)
		serverErr <- httpServer.ListenAndServe()
	}()

	select {
	case err := <-serverErr:
		if err != nil && err != http.ErrServerClosed {
			logger.Error("server stopped", "error", err)
			os.Exit(1)
		}
	case <-stop:
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = app.Shutdown(ctx)
		if err := httpServer.Shutdown(ctx); err != nil {
			logger.Error("graceful shutdown failed", "error", err)
		}
	}
}

// defaultUploadDir is aprond/uploads in the user's cache directory
// ($XDG_CACHE_HOME, usually ~/.cache, on Linux). Uploads last only as long as
// the process, like the rest of the server's state, so they are cache.
// Empty, when there is no cache directory, uses a temporary directory.
func defaultUploadDir() string {
	cache, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	return filepath.Join(cache, "aprond", "uploads")
}

// loopbackAddr reports whether a listen address binds only loopback.
func loopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func splitNonEmpty(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if part = strings.TrimSpace(part); part != "" {
			result = append(result, part)
		}
	}
	return result
}

// serveDebug serves pprof and expvar on their own listener, so profiling is
// never reachable through the public address.
func serveDebug(logger *slog.Logger, addr string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	mux.Handle("/debug/vars", expvar.Handler())
	logger.Info("debug server listening", "addr", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		logger.Error("debug server stopped", "error", err)
	}
}
