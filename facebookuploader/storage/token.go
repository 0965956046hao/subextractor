package storage

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// TokenStore persists OAuth tokens on disk. Secrets are stored locally only and
// are never written to stdout.
type TokenStore struct {
	path string
}

// StoredTokens is the on-disk JSON representation.
type StoredTokens struct {
	UserAccessToken string    `json:"user_access_token"`
	UserExpiresAt   time.Time `json:"user_expires_at"`
	PageID          string    `json:"page_id"`
	PageAccessToken string    `json:"page_access_token"`
	PageExpiresAt   time.Time `json:"page_expires_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

// NewTokenStore opens (creating parent dirs if needed) the store at path.
func NewTokenStore(path string) (*TokenStore, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("cannot create token store dir: %w", err)
	}
	return &TokenStore{path: path}, nil
}

// Load reads tokens. Returns (nil, nil) if the file does not exist yet.
func (s *TokenStore) Load() (*StoredTokens, error) {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("cannot read token store: %w", err)
	}
	var t StoredTokens
	if err := json.Unmarshal(data, &t); err != nil {
		return nil, fmt.Errorf("corrupt token store: %w", err)
	}
	return &t, nil
}

// Save writes tokens atomically (write temp + rename).
func (s *TokenStore) Save(t *StoredTokens) error {
	t.UpdatedAt = time.Now()
	data, err := json.MarshalIndent(t, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("cannot write token store: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return fmt.Errorf("cannot finalize token store: %w", err)
	}
	return nil
}

// PageTokenValid reports whether a non-expired page token is present.
func (t *StoredTokens) PageTokenValid() bool {
	if t == nil || t.PageAccessToken == "" {
		return false
	}
	// Treat zero time as "unknown expiry" -> consider valid but caller should
	// still let the API reject if truly expired.
	return t.PageExpiresAt.IsZero() || time.Now().Before(t.PageExpiresAt)
}
