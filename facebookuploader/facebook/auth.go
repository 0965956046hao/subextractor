package facebook

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"time"

	"github.com/tinh/facebook-uploader/config"
)

// OAuth scopes required for Page video/Reels publishing.
//
// VERIFY before production: Meta's required scopes may change. As of the
// Graph API v21 era these are appropriate; confirm at:
//   https://developers.facebook.com/docs/permissions/reference
const (
	DefaultUserScopes = "pages_show_list,pages_read_engagement,pages_manage_posts,business_management"
)

// Auth handles the OAuth login flow.
type Auth struct {
	cfg     *config.Config
	client  *Client
	scopes  string
	redirectURI string
}

// NewAuth builds an Auth helper.
func NewAuth(cfg *config.Config, client *Client) *Auth {
	return &Auth{
		cfg:        cfg,
		client:     client,
		scopes:     DefaultUserScopes,
		redirectURI: "http://localhost:8080/callback",
	}
}

// SetScopes overrides the requested scopes.
func (a *Auth) SetScopes(s string) { a.scopes = s }

// LoginURL builds the Facebook OAuth authorization URL.
func (a *Auth) LoginURL(state string) string {
	q := url.Values{}
	q.Set("client_id", a.cfg.AppID)
	q.Set("redirect_uri", a.redirectURI)
	q.Set("scope", a.scopes)
	q.Set("response_type", "code")
	q.Set("state", state)
	return "https://www.facebook.com/" + a.cfg.GraphAPIVersion + "/dialog/oauth?" + q.Encode()
}

// RunInteractive opens the browser, starts a localhost callback server, and
// returns the exchanged long-lived page tokens. On failure it returns an
// error. Tokens are NOT printed.
func (a *Auth) RunInteractive(ctx context.Context) (*tokenBundle, error) {
	state := randomState()
	codeCh := make(chan string, 1)
	errCh := make(chan error, 1)

	srv := &http.Server{Addr: "127.0.0.1:8080"}
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if e := q.Get("error"); e != "" {
			fmt.Fprintf(w, "Authorization failed: %s", e)
			errCh <- fmt.Errorf("authorization rejected: %s", e)
			return
		}
		if q.Get("state") != state {
			fmt.Fprint(w, "State mismatch.")
			errCh <- fmt.Errorf("state mismatch in OAuth callback")
			return
		}
		code := q.Get("code")
		fmt.Fprint(w, "Authorization complete. You may close this tab and return to the terminal.")
		codeCh <- code
	})
	srv.Handler = mux

	ln, err := net.Listen("tcp", "127.0.0.1:8080")
	if err != nil {
		return nil, fmt.Errorf("cannot start callback server: %w", err)
	}
	go func() {
		if serveErr := srv.Serve(ln); serveErr != nil && serveErr != http.ErrServerClosed {
			errCh <- serveErr
		}
	}()
	defer srv.Shutdown(context.Background())

	loginURL := a.LoginURL(state)
	if err := openBrowser(loginURL); err != nil {
		fmt.Printf("Could not open browser automatically. Open this URL manually:\n\n%s\n\n", loginURL)
	} else {
		fmt.Printf("Opened browser for Facebook login. If it did not open, visit:\n\n%s\n\n", loginURL)
	}
	fmt.Println("Waiting for authorization...")

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case err := <-errCh:
		return nil, err
	case code := <-codeCh:
		return a.exchange(ctx, code)
	}
}

type tokenBundle struct {
	UserAccessToken string
	UserExpiresIn   int
	PageID          string
	PageAccessToken string
	PageExpiresIn   int
}

// exchange performs the code -> user token -> page token exchange.
func (a *Auth) exchange(ctx context.Context, code string) (*tokenBundle, error) {
	// 1. Exchange code for short-lived user access token.
	params := url.Values{}
	params.Set("client_id", a.cfg.AppID)
	params.Set("client_secret", a.cfg.AppSecret)
	params.Set("redirect_uri", a.redirectURI)
	params.Set("code", code)

	var step1 struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := a.client.Get("oauth/access_token", params, &step1); err != nil {
		return nil, fmt.Errorf("exchange code: %w", err)
	}
	if step1.AccessToken == "" {
		return nil, fmt.Errorf("no user access token returned")
	}

	// 2. Extend to long-lived user token.
	longParams := url.Values{}
	longParams.Set("grant_type", "fb_exchange_token")
	longParams.Set("client_id", a.cfg.AppID)
	longParams.Set("client_secret", a.cfg.AppSecret)
	longParams.Set("fb_exchange_token", step1.AccessToken)
	var step2 struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := a.client.Get("oauth/access_token", longParams, &step2); err != nil {
		return nil, fmt.Errorf("extend user token: %w", err)
	}
	userToken := step2.AccessToken
	if userToken == "" {
		userToken = step1.AccessToken
	}

	// 3. Fetch page token.
	pageID := a.cfg.PageID
	pageToken, err := a.fetchPageToken(userToken, pageID)
	if err != nil {
		return nil, err
	}

	return &tokenBundle{
		UserAccessToken: userToken,
		UserExpiresIn:   step2.ExpiresIn,
		PageID:          pageToken.PageID,
		PageAccessToken: pageToken.AccessToken,
		PageExpiresIn:   pageToken.ExpiresIn,
	}, nil
}

// openBrowser launches the default browser on macOS.
func openBrowser(u string) error {
	var cmd string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		cmd = "open"
		args = []string{u}
	case "linux":
		cmd = "xdg-open"
		args = []string{u}
	case "windows":
		cmd = "rundll32"
		args = []string{"url.dll,FileProtocolHandler", u}
	default:
		return fmt.Errorf("unsupported OS")
	}
	return exec.Command(cmd, args...).Start()
}

func randomState() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

// RedirectURI returns the configured redirect. Exposed for testing/debug.
func (a *Auth) RedirectURI() string { return a.redirectURI }
