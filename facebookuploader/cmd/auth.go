package cmd

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/tinh/facebook-uploader/facebook"
	"github.com/tinh/facebook-uploader/storage"
)

func runAuth(ctx context.Context, args []string) error {
	cfg := loadConfigOrExit()
	if err := cfg.ValidateApp(); err != nil {
		return err
	}

	client := newClient(cfg)
	auth := facebook.NewAuth(cfg, client)
	// Allow caller override of scopes via env if needed.
	if v := os.Getenv("FACEBOOK_SCOPES"); v != "" {
		auth.SetScopes(v)
	}

	// Respect a 5-minute window for the user to log in.
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()

	bundle, err := auth.RunInteractive(ctx)
	if err != nil {
		return err
	}

	store, err := storage.NewTokenStore(cfg.TokenStorePath)
	if err != nil {
		return err
	}
	pageID := bundle.PageID
	if pageID == "" {
		pageID = cfg.PageID
	}
	tokens := &storage.StoredTokens{
		UserAccessToken: bundle.UserAccessToken,
		UserExpiresAt:   time.Now().Add(time.Duration(bundle.UserExpiresIn) * time.Second),
		PageID:          pageID,
		PageAccessToken: bundle.PageAccessToken,
		PageExpiresAt:   time.Now().Add(time.Duration(bundle.PageExpiresIn) * time.Second),
	}
	if err := store.Save(tokens); err != nil {
		return err
	}

	// Persist Page ID to config cache for convenience (not the secret).
	fmt.Printf("\n✓ Authentication successful. Tokens saved to %s\n", cfg.TokenStorePath)
	fmt.Printf("  Page ID: %s\n", pageID)
	fmt.Println("  You can now upload without logging in again (while the token stays valid).")
	return nil
}
