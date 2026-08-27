package facebook

import (
	"fmt"
	"io"
	"net/url"
	"os"
)

// Resumable upload chunk size (Meta requires start >= 1MB, transfer >= 1MB).
// 4 MB balances throughput and retry cost.
const chunkSize = 4 * 1024 * 1024

// VideoUploadOptions configures a Page video upload/publish.
type VideoUploadOptions struct {
	PageID       string
	AccessToken  string
	FilePath     string
	Description  string
	Publish      bool
	Title        string
	OnProgress   ProgressFunc
}

// UploadResult is returned by a successful upload session.
type UploadResult struct {
	VideoID      string
	PageID       string
	Status       string // PUBLISHED / SCHEDULED / UPLOADED (unpublished)
}

// UploadVideoPage performs a resumable chunked upload to a Page feed and
// publishes if requested. The file is streamed; never fully read into RAM.
func (c *Client) UploadVideoPage(opts VideoUploadOptions) (*UploadResult, error) {
	file, err := os.Open(opts.FilePath)
	if err != nil {
		return nil, fmt.Errorf("open video: %w", err)
	}
	defer file.Close()

	fi, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("stat video: %w", err)
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
	if err := c.PostJSON(c.videoUploadURL(opts.PageID), startParams, &start); err != nil {
		return nil, fmt.Errorf("start upload: %w", err)
	}
	sessionID := start.UploadSessionID
	if sessionID == "" {
		return nil, fmt.Errorf("no upload_session_id returned")
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
			c.videoUploadURL(opts.PageID),
			transferParams,
			chunkReader,
			"application/octet-stream",
			opts.OnProgress,
			&tr,
		)
		if err != nil {
			return nil, fmt.Errorf("transfer chunk @%d: %w", offset, err)
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
	if opts.Title != "" {
		finishParams.Set("title", opts.Title)
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
	if err := c.PostJSON(c.videoUploadURL(opts.PageID), finishParams, &fin); err != nil {
		return nil, fmt.Errorf("finish upload: %w", err)
	}

	vid := fin.VideoID
	if vid == "" {
		vid = start.VideoID
	}
	if vid == "" {
		return nil, fmt.Errorf("no video_id returned from finish phase")
	}

	status := "UPLOADED"
	if opts.Publish {
		status = "PUBLISHED"
	}
	return &UploadResult{VideoID: vid, PageID: opts.PageID, Status: status}, nil
}

// videoUploadURL returns the resumable-upload endpoint on the graph-video host.
// Video uploads must go to graph-video.facebook.com for streaming performance.
func (c *Client) videoUploadURL(pageID string) string {
	ver := versionFromBase(c.apiBase)
	return fmt.Sprintf("https://graph-video.facebook.com/%s/%s/videos/upload", ver, pageID)
}

// versionFromBase extracts "v21.0" from "https://graph.facebook.com/v21.0".
func versionFromBase(base string) string {
	idx := lastIndexByte(base, '/')
	if idx < 0 {
		return "v21.0"
	}
	v := base[idx+1:]
	if v == "" {
		return "v21.0"
	}
	return v
}

func lastIndexByte(s string, b byte) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == b {
			return i
		}
	}
	return -1
}

// GetVideoStatus fetches the current status of a published/uploaded video.
func (c *Client) GetVideoStatus(videoID, accessToken string) (string, error) {
	params := url.Values{}
	params.Set("access_token", accessToken)
	params.Set("fields", "id,status")
	var resp struct {
		ID     string `json:"id"`
		Status struct {
			VideoStatus string `json:"video_status"`
		} `json:"status"`
	}
	if err := c.Get(videoID, params, &resp); err != nil {
		return "", fmt.Errorf("get status: %w", err)
	}
	return resp.Status.VideoStatus, nil
}
