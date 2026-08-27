package facebook

import (
	"fmt"
	"io"
	"net/url"
	"os"
)

// ReelUploadOptions configures a Facebook Reel upload/publish.
type ReelUploadOptions struct {
	PageID      string
	AccessToken string
	FilePath    string
	Description string
	Publish     bool
	OnProgress  ProgressFunc
}

// UploadReel performs a resumable chunked upload of a Reel to a Page and
// publishes it. Reels use the same resumable upload protocol as Page video but
// post to the Reels endpoint (/{page-id}/video_reels). The flow is intentionally
// separated from normal video so it can evolve independently.
func (c *Client) UploadReel(opts ReelUploadOptions) (*UploadResult, error) {
	file, err := os.Open(opts.FilePath)
	if err != nil {
		return nil, fmt.Errorf("open reel video: %w", err)
	}
	defer file.Close()

	fi, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("stat reel video: %w", err)
	}
	total := fi.Size()

	// 1. start
	startParams := url.Values{}
	startParams.Set("access_token", opts.AccessToken)
	startParams.Set("upload_phase", "start")
	startParams.Set("file_size", fmt.Sprintf("%d", total))
	var start struct {
		UploadSessionID string `json:"upload_session_id"`
		VideoID         string `json:"video_id"`
		StartOffset     int64  `json:"start_offset"`
		EndOffset       int64  `json:"end_offset"`
	}
	if err := c.PostJSON(c.reelUploadURL(opts.PageID), startParams, &start); err != nil {
		return nil, fmt.Errorf("start reel upload: %w", err)
	}
	sessionID := start.UploadSessionID
	if sessionID == "" {
		return nil, fmt.Errorf("no upload_session_id returned for reel")
	}

	// 2. transfer chunks
	var offset int64
	for offset < total {
		end := offset + chunkSize
		if end > total {
			end = total
		}
		chunkReader := io.NewSectionReader(file, offset, end-offset)
		transferParams := url.Values{}
		transferParams.Set("access_token", opts.AccessToken)
		transferParams.Set("upload_phase", "transfer")
		transferParams.Set("upload_session_id", sessionID)
		transferParams.Set("start_offset", fmt.Sprintf("%d", offset))
		transferParams.Set("end_offset", fmt.Sprintf("%d", end))

		var tr struct {
			StartOffset int64 `json:"start_offset"`
			EndOffset   int64 `json:"end_offset"`
		}
		err := c.PostWithBody(
			c.reelUploadURL(opts.PageID),
			transferParams,
			chunkReader,
			"application/octet-stream",
			opts.OnProgress,
			&tr,
		)
		if err != nil {
			return nil, fmt.Errorf("transfer reel chunk @%d: %w", offset, err)
		}
		offset = tr.EndOffset
		if opts.OnProgress != nil {
			opts.OnProgress(offset, total)
		}
	}

	// 3. finish
	finishParams := url.Values{}
	finishParams.Set("access_token", opts.AccessToken)
	finishParams.Set("upload_phase", "finish")
	finishParams.Set("upload_session_id", sessionID)
	if opts.Description != "" {
		finishParams.Set("description", opts.Description)
	}
	if opts.Publish {
		finishParams.Set("published", "true")
	} else {
		finishParams.Set("published", "false")
	}

	var fin struct {
		Success bool   `json:"success"`
		VideoID string `json:"video_id"`
	}
	if err := c.PostJSON(c.reelUploadURL(opts.PageID), finishParams, &fin); err != nil {
		return nil, fmt.Errorf("finish reel upload: %w", err)
	}

	vid := fin.VideoID
	if vid == "" {
		vid = start.VideoID
	}
	if vid == "" {
		return nil, fmt.Errorf("no video_id returned from reel finish phase")
	}

	status := "UPLOADED"
	if opts.Publish {
		status = "PUBLISHED"
	}
	return &UploadResult{VideoID: vid, PageID: opts.PageID, Status: status}, nil
}

// reelUploadURL returns the Reels resumable-upload endpoint.
func (c *Client) reelUploadURL(pageID string) string {
	ver := versionFromBase(c.apiBase)
	return fmt.Sprintf("https://graph-video.facebook.com/%s/%s/video_reels", ver, pageID)
}
