package cmd

import (
	"context"
	"fmt"
	"os"

	"github.com/tinh/facebook-uploader/config"
	"github.com/tinh/facebook-uploader/facebook"
	"github.com/tinh/facebook-uploader/storage"
	"github.com/tinh/facebook-uploader/ui"
)

// Execute sets up the root command and dispatches subcommands.
func Execute(ctx context.Context) error {
	args := os.Args[1:]
	if len(args) == 0 {
		printUsage()
		return nil
	}

	switch args[0] {
	case "auth":
		return runAuth(ctx, args[1:])
	case "upload":
		return runUpload(ctx, args[1:])
	case "reel":
		return runReel(ctx, args[1:])
	case "status":
		return runStatus(ctx, args[1:])
	case "batch":
		return runBatch(ctx, args[1:])
	case "-h", "--help", "help":
		printUsage()
		return nil
	default:
		printUsage()
		return fmt.Errorf("unknown command: %s", args[0])
	}
}

func printUsage() {
	fmt.Print(`Facebook Uploader - publish videos & Reels to Facebook Pages via Meta Graph API

Usage:
  facebook-uploader <command> [flags]

Commands:
  auth     Authenticate via Facebook OAuth (browser login)
  upload   Upload a video to a Facebook Page
  reel     Upload a video as a Facebook Reel
  status   Check the status of an uploaded video/reel
  batch    Upload all videos in a directory

Run "facebook-uploader <command> --help" for flags.
`)
}

// loadConfigOrExit loads config; on error it prints and exits.
func loadConfigOrExit() *config.Config {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "config error: %v\n", err)
		os.Exit(1)
	}
	return cfg
}

// newClient builds a Facebook client from config.
func newClient(cfg *config.Config) *facebook.Client {
	return facebook.NewClient(cfg.APIBase(), nil)
}

// resolvePageToken returns a page access token from the token store, or falls
// back to the configured PAGE_ACCESS_TOKEN.
func resolvePageToken(ctx context.Context, cfg *config.Config) (pageID, token string, err error) {
	store, err := storage.NewTokenStore(cfg.TokenStorePath)
	if err != nil {
		return "", "", err
	}
	tokens, err := store.Load()
	if err != nil {
		return "", "", err
	}
	if tokens != nil && tokens.PageTokenValid() {
		pageID = tokens.PageID
		if pageID == "" {
			pageID = cfg.PageID
		}
		return pageID, tokens.PageAccessToken, nil
	}
	if cfg.PageAccessToken != "" {
		return cfg.PageID, cfg.PageAccessToken, nil
	}
	return "", "", fmt.Errorf("no valid page token; run 'facebook-uploader auth' first")
}

// fail prints a JSON/human error and exits appropriately.
func fail(o ui.Outcome, jsonOut bool) {
	if jsonOut {
		o.PrintJSONExit()
	}
	o.Print(os.Stderr, false)
	os.Exit(1)
}

// IsHelpErr reports whether err is just a -h/--help request.
func IsHelpErr(err error) bool {
	return err != nil && (err.Error() == "flag: help requested" || err.Error() == "flag: terminal prompts disabled")
}
