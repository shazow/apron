package main

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	flags "github.com/jessevdk/go-flags"
)

func parse(t *testing.T, args ...string) (*Options, *flags.Parser) {
	t.Helper()
	var options Options
	parser := flags.NewParser(&options, flags.Default&^flags.PrintErrors)
	if _, err := parser.ParseArgs(args); err != nil {
		t.Fatal(err)
	}
	return &options, parser
}

func writeConfig(t *testing.T, text string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "aprond.toml")
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestConfigFileSetsOptionsTheCommandLineDoesNot(t *testing.T) {
	path := writeConfig(t, `
addr = "0.0.0.0:9000"
public-url = "https://chat.example"
messages-per-minute = 30

[webauthn]
rp-id = "chat.example"
origin = ["https://chat.example"]

[upload]
max-mb = 5
`)
	options, parser := parse(t, "--addr", "127.0.0.1:9999", "--upload.max-mb", "7")
	if err := loadConfig(parser, options, path); err != nil {
		t.Fatal(err)
	}
	if options.Addr != "127.0.0.1:9999" || options.Upload.MaxMB != 7 {
		t.Fatalf("command line overridden: addr %q, max-mb %d", options.Addr, options.Upload.MaxMB)
	}
	if options.PublicURL != "https://chat.example" || options.MessagesPerMinute != 30 || options.WebAuthn.RPID != "chat.example" {
		t.Fatalf("file settings not applied: %+v", options)
	}
	if !reflect.DeepEqual(options.WebAuthn.Origins, []string{"https://chat.example"}) {
		t.Fatalf("a list replaces its default: %v", options.WebAuthn.Origins)
	}
	if options.Upload.MaxMessageMB != 20 {
		t.Fatalf("unset default changed: %d", options.Upload.MaxMessageMB)
	}
}

func TestConfigFileRejectsUnknownSettings(t *testing.T) {
	for _, text := range []string{`adress = ":80"`, "[upload]\nmax = 1", `config = "other.toml"`, `max-connections = "many"`} {
		options, parser := parse(t)
		if err := loadConfig(parser, options, writeConfig(t, text)); err == nil {
			t.Errorf("accepted %q", text)
		}
	}
}

func TestPrintedConfigLoadsBack(t *testing.T) {
	options, parser := parse(t, "--origin", "https://a.example", "--origin", "https://b.example", "--push.disable", "--tls.domain", "chat.example")
	var printed bytes.Buffer
	if err := printConfig(&printed, parser); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(printed.String(), "[upload]") || strings.Contains(printed.String(), "print-config") {
		t.Fatalf("printed config:\n%s", printed.String())
	}
	loaded, fresh := parse(t)
	if err := loadConfig(fresh, loaded, writeConfig(t, printed.String())); err != nil {
		t.Fatalf("%v in:\n%s", err, printed.String())
	}
	if !reflect.DeepEqual(loaded, options) {
		t.Fatalf("round trip:\n%+v\nwant\n%+v", loaded, options)
	}
}

func TestTLSDomainIsThePublicURL(t *testing.T) {
	options, _ := parse(t, "--tls.domain", "chat.example", "--webauthn.rp-id", "")
	config, err := serverConfig(*options)
	if err != nil {
		t.Fatal(err)
	}
	if config.PublicURL != "https://chat.example" || config.WebAuthn != nil {
		t.Fatalf("config: public URL %q, passkeys %v", config.PublicURL, config.WebAuthn != nil)
	}
}
