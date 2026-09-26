// Package store persists the server's state as entries: opaque values keyed
// by a kind and an ID. The server decides what each kind holds; a backend
// only needs to keep entries and apply batches of changes atomically.
package store

import (
	"errors"
	"fmt"
	"strings"
)

// Entry is one stored value. A nil Value in a batch deletes the entry.
type Entry struct {
	Kind  string
	ID    string
	Value []byte
}

// Store keeps entries across restarts.
type Store interface {
	// Load calls visit for every stored entry, in no particular order.
	Load(visit func(Entry) error) error
	// Apply writes a batch of puts and deletes atomically.
	Apply(batch []Entry) error
	// Close releases the store; it must not be used afterwards.
	Close() error
}

// Open opens a store named by a URL-like string:
//
//	memory             entries kept only in this process
//	sqlite:<path>      a SQLite database file, created if missing
func Open(name string) (Store, error) {
	scheme, path, _ := strings.Cut(name, ":")
	switch scheme {
	case "memory":
		return NewMemory(), nil
	case "sqlite":
		if path == "" {
			return nil, errors.New("sqlite store needs a path, such as sqlite:aprond.db")
		}
		return OpenSQLite(strings.TrimPrefix(path, "//"))
	}
	return nil, fmt.Errorf("unknown store %q; use memory or sqlite:<path>", name)
}
