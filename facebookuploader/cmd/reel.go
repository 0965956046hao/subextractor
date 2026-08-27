package cmd

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/tinh/facebook-uploader/facebook"
	"github.com/tinh/facebook-uploader/ui"
)

var reelFlags struct {
	video       string
	description string
	pageID      string
	publish     bool
	json        bool
}

func runReel(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("reel", flag.ContinueOnError)
	fs.StringVar(&reelFlags.video, "video", "", "Path to reel video file")
	fs.StringVar(&reelFlags.description, "description", "", "Reel description / caption")
	fs.StringVar(&reelFlags.pageID, "page-id", "", "Facebook Page ID (overrides config)")
	fs.BoolVar(&reelFlags.publish, "publish", false, "Publish immediately")
	fs.BoolVar(&reelFlags.json, "json", false, "Output JSON to stdout")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if reelFlags.video == "" {
		return fmt.Errorf("--video is required")
	}
	if _, err := os.Stat(reelFlags.video); err != nil {
		return fmt.Errorf("video not found: %w", err)
	}

	cfg := loadConfigOrExit()
	if reelFlags.publish == false && cfg.DefaultPublish {
		reelFlags.publish = true
	}

	pageID, token, err := resolvePageToken(ctx, cfg)
	if err != nil {
		return err
	}
	if reelFlags.pageID != "" {
		pageID = reelFlags.pageID
	}

	client := newClient(cfg)

	if !reelFlags.json {
		fmt.Println("Facebook Uploader — Reels")
		fmt.Printf("Video: %s\n", filepath.Base(reelFlags.video))
	}

	bar := ui.NewProgressBar(0)
	var progress facebook.ProgressFunc
	if !reelFlags.json {
		progress = func(t, total int64) {
			if total > 0 {
				bar.Update(t, total)
			}
		}
	}

	if !reelFlags.json {
		fmt.Println("\nInitializing Reel upload...")
	}
	res, err := client.UploadReel(facebook.ReelUploadOptions{
		PageID:      pageID,
		AccessToken: token,
		FilePath:    reelFlags.video,
		Description: reelFlags.description,
		Publish:     reelFlags.publish,
		OnProgress:  progress,
	})
	if err != nil {
		apiErr, ok := err.(*facebook.APIError)
		if !ok {
			fail(ui.Outcome{Success: false, Platform: "facebook", PageID: pageID, ErrCode: "REEL_FAILED", ErrMsg: err.Error()}, reelFlags.json)
		}
		model := apiErr.ToModel()
		fail(ui.Outcome{Success: false, Platform: "facebook", PageID: pageID, ErrCode: model.Code, ErrMsg: model.Message}, reelFlags.json)
	}

	if !reelFlags.json {
		bar.Finish()
		fmt.Println("Publishing Reel...")
	}

	outcome := ui.Outcome{
		Success:  true,
		Platform: "facebook",
		PageID:   res.PageID,
		VideoID:  res.VideoID,
		Status:   res.Status,
	}
	if reelFlags.json {
		outcome.PrintJSONExit()
	}
	outcome.Print(os.Stdout, false)
	return nil
}
