package ui

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
)

// Outcome is the final result shown to the user.
type Outcome struct {
	Success  bool
	Platform string
	PageID   string
	VideoID  string
	Status   string
	ErrCode  string
	ErrMsg   string
}

// Print writes either JSON (if jsonOut) or a human-friendly summary to w.
func (o Outcome) Print(w io.Writer, jsonOut bool) {
	if jsonOut {
		res := map[string]interface{}{
			"success":  o.Success,
			"platform": o.Platform,
		}
		if o.PageID != "" {
			res["page_id"] = o.PageID
		}
		if o.VideoID != "" {
			res["video_id"] = o.VideoID
		}
		if o.Status != "" {
			res["status"] = o.Status
		}
		if !o.Success {
			res["error"] = map[string]string{
				"code":    o.ErrCode,
				"message": o.ErrMsg,
			}
		}
		b, _ := json.Marshal(res)
		fmt.Fprintln(w, string(b))
		return
	}

	if !o.Success {
		fmt.Fprintf(w, "\n✗ Upload failed\n\n")
		fmt.Fprintf(w, "  Code   : %s\n", o.ErrCode)
		fmt.Fprintf(w, "  Message: %s\n", o.ErrMsg)
		return
	}
	fmt.Fprintf(w, "\n✓ Upload successful\n\n")
	fmt.Fprintf(w, "  Platform: %s\n", o.Platform)
	if o.PageID != "" {
		fmt.Fprintf(w, "  Page ID : %s\n", o.PageID)
	}
	if o.VideoID != "" {
		fmt.Fprintf(w, "  Video ID: %s\n", o.VideoID)
	}
	if o.Status != "" {
		fmt.Fprintf(w, "  Status  : %s\n", o.Status)
	}
}

// PrintJSONExit prints JSON to stdout and exits with code (0 success, 1 fail).
func (o Outcome) PrintJSONExit() {
	fmt.Println(mustJSON(o))
	if o.Success {
		os.Exit(0)
	}
	os.Exit(1)
}

func mustJSON(o Outcome) string {
	res := map[string]interface{}{
		"success":  o.Success,
		"platform": o.Platform,
	}
	if o.PageID != "" {
		res["page_id"] = o.PageID
	}
	if o.VideoID != "" {
		res["video_id"] = o.VideoID
	}
	if o.Status != "" {
		res["status"] = o.Status
	}
	if !o.Success {
		res["error"] = map[string]string{"code": o.ErrCode, "message": o.ErrMsg}
	}
	b, _ := json.Marshal(res)
	return string(b)
}
