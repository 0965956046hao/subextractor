package cmd

import (
	"context"
	"flag"
	"fmt"

	"github.com/tinh/facebook-uploader/facebook"
	"github.com/tinh/facebook-uploader/ui"
)

func runStatus(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	id := fs.String("id", "", "Video/Reel ID to check")
	jsonOut := fs.Bool("json", false, "Output JSON to stdout")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *id == "" {
		return fmt.Errorf("--id is required")
	}

	cfg := loadConfigOrExit()
	_, token, err := resolvePageToken(ctx, cfg)
	if err != nil {
		return err
	}
	client := newClient(cfg)

	status, err := client.GetVideoStatus(*id, token)
	if err != nil {
		apiErr, ok := err.(*facebook.APIError)
		if !ok {
			fail(ui.Outcome{Success: false, Platform: "facebook", VideoID: *id, ErrCode: "STATUS_FAILED", ErrMsg: err.Error()}, *jsonOut)
		}
		model := apiErr.ToModel()
		fail(ui.Outcome{Success: false, Platform: "facebook", VideoID: *id, ErrCode: model.Code, ErrMsg: model.Message}, *jsonOut)
	}

	if *jsonOut {
		ui.Outcome{Success: true, Platform: "facebook", VideoID: *id, Status: status}.PrintJSONExit()
	}
	fmt.Printf("Video ID: %s\nStatus  : %s\n", *id, status)
	return nil
}
