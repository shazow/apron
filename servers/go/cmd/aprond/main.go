package main

import (
	"context"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/shazow/apron/servers/go/internal/server"
)

func main() {
	addr := flag.String("addr", ":8080", "HTTP and WebSocket listen address")
	staticDir := flag.String("static-dir", "", "directory containing the built frontend")
	origins := flag.String("origin", "", "comma-separated allowed WebSocket origins; empty uses localhost defaults")
	allowAnyOrigin := flag.Bool("allow-any-origin", false, "disable WebSocket origin checks")
	rpID := flag.String("webauthn-rp-id", "localhost", "passkey relying party domain; empty disables passkeys")
	rpOrigins := flag.String("webauthn-origin", "http://localhost:5173,http://localhost:8080", "comma-separated exact frontend origins for passkeys")
	flag.Parse()

	config := server.DefaultConfig()
	config.StaticDir = *staticDir
	config.AllowAnyOrigin = *allowAnyOrigin
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
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(stop)

	serverErr := make(chan error, 1)
	go func() {
		logger.Info("apron server listening", "addr", *addr, "static_dir", *staticDir)
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
