package store

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite" // The pure-Go SQLite driver, registered as "sqlite".
)

// SQLite keeps entries in one table of a SQLite database, in WAL mode so
// reads do not block the single writer.
type SQLite struct {
	db *sql.DB
}

const sqliteSchema = `
CREATE TABLE IF NOT EXISTS entries (
	kind  TEXT NOT NULL,
	id    TEXT NOT NULL,
	value BLOB NOT NULL,
	PRIMARY KEY (kind, id)
) WITHOUT ROWID;
`

// OpenSQLite opens or creates the database at path.
func OpenSQLite(path string) (*SQLite, error) {
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
	}
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// One connection serializes writes, which SQLite requires anyway.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(sqliteSchema); err != nil {
		db.Close()
		return nil, fmt.Errorf("creating the schema in %s: %w", path, err)
	}
	// The database holds passkey credentials and session hashes. SQLite
	// gives its WAL and shared-memory files the database file's mode.
	if err := os.Chmod(path, 0o600); err != nil {
		db.Close()
		return nil, err
	}
	return &SQLite{db: db}, nil
}

func (s *SQLite) Load(visit func(Entry) error) error {
	rows, err := s.db.Query(`SELECT kind, id, value FROM entries`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var entry Entry
		if err := rows.Scan(&entry.Kind, &entry.ID, &entry.Value); err != nil {
			return err
		}
		if err := visit(entry); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (s *SQLite) Apply(batch []Entry) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	put, err := tx.Prepare(`INSERT INTO entries (kind, id, value) VALUES (?, ?, ?)
		ON CONFLICT (kind, id) DO UPDATE SET value = excluded.value`)
	if err != nil {
		return err
	}
	defer put.Close()
	del, err := tx.Prepare(`DELETE FROM entries WHERE kind = ? AND id = ?`)
	if err != nil {
		return err
	}
	defer del.Close()
	for _, entry := range batch {
		if entry.Value == nil {
			_, err = del.Exec(entry.Kind, entry.ID)
		} else {
			_, err = put.Exec(entry.Kind, entry.ID, entry.Value)
		}
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *SQLite) Close() error {
	return s.db.Close()
}
