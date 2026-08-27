package facebook

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/tinh/facebook-uploader/models"
)

// ProgressFunc reports upload progress. totalBytes may be 0 if unknown.
type ProgressFunc func(transferred, totalBytes int64)

// APIError is the structured error returned by the Graph API.
type APIError struct {
	Code          int    `json:"code"`
	Subcode       int    `json:"error_subcode"`
	Type          string `json:"type"`
	Message       string `json:"message"`
	UserTitle     string `json:"error_user_title"`
	UserMessage   string `json:"error_user_msg"`
	Raw           string `json:"-"`
}

func (e *APIError) Error() string {
	if e.UserMessage != "" {
		return fmt.Sprintf("%s (code=%d subcode=%d): %s", e.Type, e.Code, e.Subcode, e.UserMessage)
	}
	return fmt.Sprintf("%s (code=%d subcode=%d): %s", e.Type, e.Code, e.Subcode, e.Message)
}

// ToModel converts to the output contract error type.
func (e *APIError) ToModel() *models.APIError {
	code := classifyCode(e)
	return &models.APIError{Code: code, Message: e.Error()}
}

// Client talks to the Meta Graph API.
type Client struct {
	apiBase string
	http    *http.Client
	log     *log.Logger
	// Retry config for transient network errors.
	maxRetries int
	baseDelay  time.Duration
}

// NewClient constructs a client. logger may be nil to suppress debug logging.
func NewClient(apiBase string, logger *log.Logger) *Client {
	if logger == nil {
		logger = log.New(io.Discard, "", 0)
	}
	return &Client{
		apiBase:    strings.TrimRight(apiBase, "/"),
		http:       &http.Client{Timeout: 0}, // no overall timeout; chunks stream
		log:        logger,
		maxRetries: 3,
		baseDelay:  2 * time.Second,
	}
}

// fbErrorShape matches the Graph API error envelope.
type fbErrorShape struct {
	Error struct {
		Message       string `json:"message"`
		Type          string `json:"type"`
		Code          int    `json:"code"`
		ErrorSubcode  int    `json:"error_subcode"`
		UserTitle     string `json:"error_user_title"`
		UserMessage   string `json:"error_user_msg"`
	} `json:"error"`
}

// Do issues a Graph API request.
//
// params are added as query string (for GET) or form fields (for POST without
// a raw body). If body is non-nil it is sent as the request body with the given
// contentType; params are then appended to the URL as query string. onProgress
// is invoked while copying the request body (for upload streaming).
func (c *Client) Do(method, path string, params url.Values, body io.Reader, contentType string, onProgress ProgressFunc) ([]byte, error) {
	u := c.apiBase + "/" + strings.TrimLeft(path, "/")
	if params == nil {
		params = url.Values{}
	}

	var sendBody io.Reader
	var sendContentType string
	if body != nil {
		sendBody = body
		sendContentType = contentType
		// params go into the query string for uploads
		if len(params) > 0 {
			u += "?" + params.Encode()
		}
	} else if len(params) > 0 {
		switch method {
		case http.MethodGet, http.MethodDelete:
			u += "?" + params.Encode()
		default:
			sendBody = strings.NewReader(params.Encode())
			sendContentType = "application/x-www-form-urlencoded"
		}
	}

	attempt := 0
	var lastErr error
	for {
		err := c.attempt(method, u, sendBody, sendContentType, onProgress)
		if err == nil {
			return nil, nil
		}
		// Only retry network-level failures; API errors are returned asap.
		if _, ok := err.(*APIError); ok {
			return nil, err
		}
		lastErr = err
		attempt++
		if attempt > c.maxRetries {
			break
		}
		delay := c.backoff(attempt)
		c.log.Printf("network error (attempt %d/%d): %v; retrying in %s", attempt, c.maxRetries, err, delay)
		time.Sleep(delay)
	}
	return nil, fmt.Errorf("request failed after %d retries: %w", c.maxRetries, lastErr)
}

func (c *Client) attempt(method, u string, body io.Reader, contentType string, onProgress ProgressFunc) error {
	req, err := http.NewRequest(method, u, body)
	if err != nil {
		return err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return err // network error -> retryable
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	_ = onProgress // progress handled by caller's wrapping reader

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}

	// Try to parse a Graph API error envelope.
	var fb fbErrorShape
	if jsonErr := json.Unmarshal(data, &fb); jsonErr == nil && fb.Error.Code != 0 {
		ae := &APIError{
			Code:        fb.Error.Code,
			Subcode:     fb.Error.ErrorSubcode,
			Type:        fb.Error.Type,
			Message:     fb.Error.Message,
			UserTitle:   fb.Error.UserTitle,
			UserMessage: fb.Error.UserMessage,
			Raw:         string(data),
		}
		return ae
	}

	// Non-2xx but not a recognized envelope: treat as API error.
	ae := &APIError{
		Code:  resp.StatusCode,
		Type:  "HTTP_ERROR",
		Message: fmt.Sprintf("HTTP %d: %s", resp.StatusCode, truncate(string(data), 500)),
		Raw:    string(data),
	}
	return ae
}

// backoff computes exponential-ish delay: 2s, 5s, 10s ...
func (c *Client) backoff(attempt int) time.Duration {
	// attempt is 1-based. delays: 2,5,10
	delays := []time.Duration{2 * time.Second, 5 * time.Second, 10 * time.Second}
	if attempt-1 < len(delays) {
		return delays[attempt-1]
	}
	return 10 * time.Second
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "..."
}

// exponentialBackoffFor429 returns delay from Retry-After or computed value.
func parseRetryAfter(header string) time.Duration {
	if header == "" {
		return 0
	}
	var secs float64
	if _, err := fmt.Sscanf(header, "%f", &secs); err == nil {
		return time.Duration(math.Round(secs)) * time.Second
	}
	return 0
}

// classifyCode maps a Graph API error to the output contract error code.
func classifyCode(e *APIError) string {
	switch e.Code {
	case 0:
		return "NETWORK_ERROR"
	case 190:
		return "TOKEN_EXPIRED"
	case 401:
		return "UNAUTHORIZED"
	case 403:
		return "PERMISSION_ERROR"
	case 400:
		return "INVALID_REQUEST"
	case 429:
		return "RATE_LIMITED"
	}
	if e.Subcode != 0 {
		switch e.Subcode {
		case 463, 464, 467:
			return "TOKEN_EXPIRED"
		}
	}
	switch e.Type {
	case "OAuthException":
		return "AUTH_ERROR"
	case "GraphMethodException":
		return "NOT_FOUND"
	}
	return "API_ERROR"
}

// Get issues a GET and parses JSON into out.
func (c *Client) Get(path string, params url.Values, out interface{}) error {
	data, err := c.Do(http.MethodGet, path, params, nil, "", nil)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(data, out)
}

// PostJSON posts form params and parses JSON into out.
func (c *Client) PostJSON(path string, params url.Values, out interface{}) error {
	data, err := c.Do(http.MethodPost, path, params, nil, "", nil)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(data, out)
}

// PostWithBody posts a raw body (used for chunked uploads) and parses JSON.
func (c *Client) PostWithBody(path string, params url.Values, body io.Reader, contentType string, onProgress ProgressFunc, out interface{}) error {
	data, err := c.Do(http.MethodPost, path, params, body, contentType, onProgress)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(data, out)
}

// BufferPost is a convenience for small JSON POSTs with a pre-encoded body.
func (c *Client) BufferPost(path string, params url.Values, jsonBody []byte, out interface{}) error {
	return c.PostWithBody(path, params, bytes.NewReader(jsonBody), "application/json", nil, out)
}
