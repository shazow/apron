package store

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func load(t *testing.T, s Store) map[string]string {
	t.Helper()
	got := make(map[string]string)
	if err := s.Load(func(e Entry) error {
		got[e.Kind+"/"+e.ID] = string(e.Value)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return got
}

// TestBackends checks that every backend keeps, replaces, and deletes
// entries, and that a batch applies as a whole.
func TestBackends(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "aprond.db")
	backends := map[string]func() Store{
		"memory": func() Store { return NewMemory() },
		"sqlite": func() Store {
			s, err := Open("sqlite:" + path)
			if err != nil {
				t.Fatal(err)
			}
			return s
		},
	}
	for name, open := range backends {
		t.Run(name, func(t *testing.T) {
			s := open()
			if err := s.Apply([]Entry{
				{Kind: "room", ID: "general", Value: []byte(`{"title":"General"}`)},
				{Kind: "record", ID: "1", Value: []byte(`{}`)},
				{Kind: "record", ID: "2", Value: []byte(`{}`)},
			}); err != nil {
				t.Fatal(err)
			}
			if err := s.Apply([]Entry{
				{Kind: "room", ID: "general", Value: []byte(`{"title":"Ops"}`)},
				{Kind: "record", ID: "1"},
			}); err != nil {
				t.Fatal(err)
			}
			want := map[string]string{"room/general": `{"title":"Ops"}`, "record/2": `{}`}
			if got := load(t, s); !reflect.DeepEqual(got, want) {
				t.Fatalf("entries = %v, want %v", got, want)
			}
			if name == "sqlite" {
				if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
					t.Fatalf("database file mode: %v %v", info.Mode(), err)
				}
				// A reopened database keeps its entries.
				if err := s.Close(); err != nil {
					t.Fatal(err)
				}
				s = open()
				if got := load(t, s); !reflect.DeepEqual(got, want) {
					t.Fatalf("reopened entries = %v, want %v", got, want)
				}
			}
			if err := s.Close(); err != nil {
				t.Fatal(err)
			}
		})
	}
	if _, err := Open("postgres://x"); err == nil {
		t.Fatal("unknown store scheme accepted")
	}
}
