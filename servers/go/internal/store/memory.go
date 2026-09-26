package store

import (
	"bytes"
	"sync"
)

// Memory keeps entries in this process only. A server started again with
// the same Memory resumes its state, which tests use; a new Memory is empty.
type Memory struct {
	mu      sync.Mutex
	entries map[string]map[string][]byte
}

func NewMemory() *Memory {
	return &Memory{entries: make(map[string]map[string][]byte)}
}

func (m *Memory) Load(visit func(Entry) error) error {
	m.mu.Lock()
	var all []Entry
	for kind, entries := range m.entries {
		for id, value := range entries {
			all = append(all, Entry{Kind: kind, ID: id, Value: bytes.Clone(value)})
		}
	}
	m.mu.Unlock()
	for _, entry := range all {
		if err := visit(entry); err != nil {
			return err
		}
	}
	return nil
}

func (m *Memory) Apply(batch []Entry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, entry := range batch {
		if entry.Value == nil {
			delete(m.entries[entry.Kind], entry.ID)
			continue
		}
		if m.entries[entry.Kind] == nil {
			m.entries[entry.Kind] = make(map[string][]byte)
		}
		m.entries[entry.Kind][entry.ID] = bytes.Clone(entry.Value)
	}
	return nil
}

func (m *Memory) Close() error { return nil }
