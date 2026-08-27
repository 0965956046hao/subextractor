package models

// UploadResult is the unified success/error output for all commands.
// It is produced as JSON when --json is passed, and the human-friendly summary
// is derived from it.
type UploadResult struct {
	Success bool   `json:"success"`
	Platform string `json:"platform"`
	PageID  string `json:"page_id,omitempty"`
	VideoID string `json:"video_id,omitempty"`
	Status  string `json:"status,omitempty"`
	Error   *APIError `json:"error,omitempty"`
}

// APIError mirrors the structured error output contract.
type APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// JobRecord is used by the batch command to persist per-file results.
type JobRecord struct {
	File   string `json:"file"`
	Status string `json:"status"`
	VideoID string `json:"video_id,omitempty"`
	Error  string `json:"error,omitempty"`
}
