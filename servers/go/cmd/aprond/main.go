package main

import (
	"context"
	"crypto/tls"
	"errors"
	"expvar"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/pprof"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	flags "github.com/jessevdk/go-flags"
	"golang.org/x/crypto/acme/autocert"
	"golang.org/x/net/netutil"
	"golang.org/x/sync/errgroup"

	"github.com/shazow/apron/servers/go/internal/server"
	"github.com/shazow/apron/servers/go/internal/store"
)

// Options are the command line flags, which a TOML file given with
// --config can also set. Each group's namespace is a flag prefix
// (--upload.dir) and a TOML table ([upload] dir = ...).
type Options struct {
	Config      string `long:"config" description:"Load settings from a TOML file; flags given on the command line take precedence (use --print-config for an example)"`
	PrintConfig bool   `long:"print-config" description:"Print the current settings as TOML and exit"`

	Addr                   string   `long:"addr" default:"127.0.0.1:8080" description:"HTTP and WebSocket listen address; :8080 listens on every interface"`
	StaticDir              string   `long:"static-dir" description:"Directory containing the built frontend"`
	Origins                []string `long:"origin" description:"Allowed WebSocket origin pattern; repeat for more (default: localhost, 127.0.0.1, and ::1)"`
	AllowAnyOrigin         bool     `long:"allow-any-origin" description:"Disable WebSocket origin checks"`
	PublicURL              string   `long:"public-url" description:"External base URL of upload, file, and stream links, such as https://chat.example (default: each request's host, or https://<tls.domain>)"`
	MaxConnections         int      `long:"max-connections" description:"Maximum concurrent WebSockets; 0 is unlimited"`
	MaxListenerConnections int      `long:"max-listener-connections" description:"Maximum concurrent TCP connections on the listener, HTTP included; 0 is unlimited"`
	MessagesPerMinute      int      `long:"messages-per-minute" description:"Burst of new messages, room_set requests, and /avatar commands per user, refilled over a minute; 0 is unlimited"`
	DebugAddr              string   `long:"debug-addr" description:"Listen address for unauthenticated pprof and expvar under /debug/, such as 127.0.0.1:6060; empty disables"`
	Store                  string   `long:"store" description:"Where state is kept: sqlite:<path> for a SQLite database, or memory to keep nothing across restarts"`

	WebAuthn struct {
		RPID    string   `long:"rp-id" default:"localhost" description:"Passkey relying party domain; empty disables passkeys"`
		Origins []string `long:"origin" default:"http://localhost:5173" default:"http://localhost:8080" description:"Exact frontend origin for passkeys; repeat for more"`
	} `group:"Passkeys" namespace:"webauthn"`

	Upload struct {
		Dir          string `long:"dir" description:"Directory holding uploaded files; upload files the store does not refer to are removed at start"`
		MaxMB        int64  `long:"max-mb" default:"20" description:"Maximum size of one upload, in MiB"`
		MaxMessageMB int64  `long:"max-message-mb" default:"20" description:"Maximum total size of one message's uploads, in MiB"`
		MaxStorageMB int64  `long:"max-storage-mb" default:"1000" description:"Total size of hosted uploads, in MiB, beyond which the oldest are removed from their messages"`
	} `group:"Uploads" namespace:"upload"`

	Push struct {
		Disable       bool `long:"disable" description:"Do not offer push registration"`
		AllowInsecure bool `long:"allow-insecure" description:"Accept http and internal push endpoints (development only)"`
	} `group:"Push" namespace:"push"`

	TLS struct {
		Domains  []string `long:"domain" description:"Serve HTTPS with Let's Encrypt certificates for this domain; repeat for more. Replaces --addr with --tls.addr"`
		Addr     string   `long:"addr" default:":443" description:"HTTPS listen address when --tls.domain is set"`
		HTTPAddr string   `long:"http-addr" default:":80" description:"HTTP listen address for ACME challenges and redirects to HTTPS when --tls.domain is set"`
		CacheDir string   `long:"cache-dir" description:"Directory caching certificates (default: aprond/autocert in the user cache directory)"`
		Email    string   `long:"email" description:"Contact email given to Let's Encrypt"`
	} `group:"TLS" namespace:"tls"`
}

func main() {
	var options Options
	options.Store = "sqlite:" + filepath.Join(userDataDir(), "aprond.db")
	options.Upload.Dir = filepath.Join(userDataDir(), "uploads")
	options.TLS.CacheDir = userCacheDir("autocert")
	parser := flags.NewParser(&options, flags.Default)
	if _, err := parser.Parse(); err != nil {
		if flagErr, ok := err.(*flags.Error); ok && flagErr.Type == flags.ErrHelp {
			os.Exit(0)
		}
		os.Exit(1)
	}
	if options.Config != "" {
		if err := loadConfig(parser, &options, options.Config); err != nil {
			fmt.Fprintf(os.Stderr, "Failed to load %s: %s\n", options.Config, err)
			os.Exit(1)
		}
	}
	if options.PrintConfig {
		if err := printConfig(os.Stdout, parser); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(logger, options); err != nil {
		logger.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

// serverConfig turns options into the server's configuration.
// The caller closes config.Store unless it hands it to a server.
func serverConfig(options Options) (server.Config, error) {
	config := server.DefaultConfig()
	config.StaticDir = options.StaticDir
	config.AllowAnyOrigin = options.AllowAnyOrigin
	config.PublicURL = options.PublicURL
	if config.PublicURL == "" && len(options.TLS.Domains) > 0 {
		config.PublicURL = "https://" + options.TLS.Domains[0]
	}
	config.MaxConnections = options.MaxConnections
	config.MessagesPerMinute = options.MessagesPerMinute
	config.DisablePush = options.Push.Disable
	config.AllowInsecurePush = options.Push.AllowInsecure
	config.UploadDir = options.Upload.Dir
	config.MaxUploadBytes = options.Upload.MaxMB << 20
	config.MaxMessageUploadBytes = options.Upload.MaxMessageMB << 20
	config.MaxUploadStorageBytes = options.Upload.MaxStorageMB << 20
	if len(options.Origins) > 0 {
		config.OriginPatterns = options.Origins
	}
	if options.WebAuthn.RPID != "" {
		var err error
		config.WebAuthn, err = webauthn.New(&webauthn.Config{
			RPID: options.WebAuthn.RPID, RPDisplayName: "Apron", RPOrigins: options.WebAuthn.Origins,
		})
		if err != nil {
			return config, fmt.Errorf("invalid WebAuthn configuration: %w", err)
		}
	}
	return config, nil
}

// run serves until SIGINT or SIGTERM, or until any listener fails, then
// shuts every server down.
func run(logger *slog.Logger, options Options) error {
	config, err := serverConfig(options)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	group, ctx := errgroup.WithContext(ctx)

	config.Store, err = store.Open(options.Store)
	if err != nil {
		return err
	}
	app, err := server.Open(config)
	if err != nil {
		config.Store.Close()
		return fmt.Errorf("restoring state from %s: %w", options.Store, err)
	}
	var servers []*http.Server
	serve := func(name string, srv *http.Server, listener net.Listener) {
		servers = append(servers, srv)
		group.Go(func() error {
			logger.Info(name+" listening", "addr", listener.Addr().String())
			if err := srv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
				return fmt.Errorf("%s: %w", name, err)
			}
			return nil
		})
	}
	newServer := func(handler http.Handler) *http.Server {
		return &http.Server{
			Handler:           handler,
			ReadHeaderTimeout: 5 * time.Second,
			// Idle keep-alive connections close; WebSockets and streams are
			// hijacked or long-lived requests, which it does not affect.
			IdleTimeout: 2 * time.Minute,
		}
	}
	listen := func(addr string) (net.Listener, error) {
		listener, err := net.Listen("tcp", addr)
		if err != nil {
			// Listeners opened so far close with their servers.
			for _, srv := range servers {
				_ = srv.Close()
			}
			return nil, err
		}
		if options.MaxListenerConnections > 0 {
			listener = netutil.LimitListener(listener, options.MaxListenerConnections)
		}
		return listener, nil
	}

	if len(options.TLS.Domains) > 0 {
		manager := &autocert.Manager{
			Prompt:     autocert.AcceptTOS,
			HostPolicy: autocert.HostWhitelist(options.TLS.Domains...),
			Cache:      autocert.DirCache(options.TLS.CacheDir),
			Email:      options.TLS.Email,
		}
		listener, err := listen(options.TLS.Addr)
		if err != nil {
			return err
		}
		serve("apron server (https)", newServer(app.Handler()), tls.NewListener(listener, manager.TLSConfig()))
		challenges, err := listen(options.TLS.HTTPAddr)
		if err != nil {
			return err
		}
		serve("ACME challenges and redirects (http)", newServer(manager.HTTPHandler(nil)), challenges)
	} else {
		listener, err := listen(options.Addr)
		if err != nil {
			return err
		}
		serve("apron server", newServer(app.Handler()), listener)
	}
	if options.DebugAddr != "" {
		if !loopbackAddr(options.DebugAddr) {
			logger.Warn("the debug listener is unauthenticated and not bound to loopback", "addr", options.DebugAddr)
		}
		listener, err := listen(options.DebugAddr)
		if err != nil {
			return err
		}
		serve("debug server", newServer(debugHandler()), listener)
	}
	logger.Info("serving", "store", options.Store, "static_dir", options.StaticDir, "upload_dir", options.Upload.Dir)

	group.Go(func() error {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = app.Shutdown(shutdown)
		for _, srv := range servers {
			if err := srv.Shutdown(shutdown); err != nil {
				logger.Error("graceful shutdown failed", "error", err)
			}
		}
		return nil
	})
	return group.Wait()
}

// userDataDir is aprond in the user's data directory: $XDG_DATA_HOME,
// usually ~/.local/share, on Linux and other Unix systems, and the
// application data directory on macOS and Windows.
func userDataDir() string {
	switch runtime.GOOS {
	case "darwin", "windows", "ios", "plan9":
		if dir, err := os.UserConfigDir(); err == nil {
			return filepath.Join(dir, "aprond")
		}
	default:
		if dir := os.Getenv("XDG_DATA_HOME"); filepath.IsAbs(dir) {
			return filepath.Join(dir, "aprond")
		}
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, ".local", "share", "aprond")
		}
	}
	return "aprond"
}

// userCacheDir is aprond/<name> in the user's cache directory
// ($XDG_CACHE_HOME, usually ~/.cache, on Linux), or empty when there is
// none.
func userCacheDir(name string) string {
	cache, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	return filepath.Join(cache, "aprond", name)
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

// debugHandler serves pprof and expvar on their own listener, so profiling
// is never reachable through the public address.
func debugHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	mux.Handle("/debug/vars", expvar.Handler())
	return mux
}
