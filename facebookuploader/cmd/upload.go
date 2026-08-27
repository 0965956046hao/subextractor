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

var uploadFlags struct {
	video       string
	description string
	pageID      string
	publish     bool
	json        bool
}

func runUpload(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("upload", flag.ContinueOnError)
	fs.StringVar(&uploadFlags.video, "video", "", "Path to video file")
	fs.StringVar(&uploadFlags.description, "description", "", "Post description")
	fs.StringVar(&uploadFlags.pageID, "page-id", "", "Facebook Page ID (overrides config)")
	fs.BoolVar(&uploadFlags.publish, "publish", false, "Publish immediately")
	fs.BoolVar(&uploadFlags.json, "json", false, "Output JSON to stdout")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if uploadFlags.video == "" {
		return fmt.Errorf("--video is required")
	}
	if _, err := os.Stat(uploadFlags.video); err != nil {
		return fmt.Errorf("video not found: %w", err)
	}

	cfg := loadConfigOrExit()
	if uploadFlags.publish == false && cfg.DefaultPublish {
		uploadFlags.publish = true
	}

	pageID, token, err := resolvePageToken(ctx, cfg)
	if err != nil {
		return err
	}
	if uploadFlags.pageID != "" {
		pageID = uploadFlags.pageID
	}

	client := newClient(cfg)

	if !uploadFlags.json {
		fmt.Println("Facebook Uploader")
		fmt.Printf("Video: %s\n", filepath.Base(uploadFlags.video))
	}

	bar := ui.NewProgressBar(0)
	var progress facebook.ProgressFunc
	if !uploadFlags.json {
		progress = func(t, total int64) {
			if total > 0 {
				bar.Update(t, total)
			}
		}
	}

	if !uploadFlags.json {
		fmt.Println("\nUploading...")
	}
	res, err := client.UploadVideoPage(facebook.VideoUploadOptions{
		PageID:      pageID,
		AccessToken: token,
		FilePath:    uploadFlags.video,
		Description: uploadFlags.description,
		Publish:     uploadFlags.publish,
		OnProgress:  progress,
	})
	if err != nil {
		apiErr, ok := err.(*facebook.APIError)
		if !ok {
			fail(ui.Outcome{Success: false, Platform: "facebook", PageID: pageID, ErrCode: "UPLOAD_FAILED", ErrMsg: err.Error()}, uploadFlags.json)
		}
		model := apiErr.ToModel()
		fail(ui.Outcome{Success: false, Platform: "facebook", PageID: pageID, ErrCode: model.Code, ErrMsg: model.Message}, uploadFlags.json)
	}

	if !uploadFlags.json {
		bar.Finish()
		fmt.Println("Publishing...")
	}

	outcome := ui.Outcome{
		Success:  true,
		Platform: "facebook",
		PageID:   res.PageID,
		VideoID:  res.VideoID,
		Status:   res.Status,
	}
	if uploadFlags.json {
		outcome.PrintJSONExit()
	}
	outcome.Print(os.Stdout, false)
	return nil
}
