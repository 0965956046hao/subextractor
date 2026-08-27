package facebook

import (
	"fmt"
	"net/url"
)

// PageToken is a page and its access token.
type PageToken struct {
	PageID      string `json:"id"`
	Name        string `json:"name"`
	AccessToken string `json:"access_token"`
	ExpiresIn   int    `json:"expires_in"`
}

// GetPages lists pages the user token can manage (with their tokens).
func (a *Auth) GetPages(userToken string) ([]PageToken, error) {
	params := url.Values{}
	params.Set("access_token", userToken)
	var resp struct {
		Data []PageToken `json:"data"`
	}
	if err := a.client.Get("me/accounts", params, &resp); err != nil {
		return nil, fmt.Errorf("list pages: %w", err)
	}
	return resp.Data, nil
}

// fetchPageToken resolves a page access token, either for the configured page
// or the first manageable page if none is configured.
func (a *Auth) fetchPageToken(userToken, pageID string) (*PageToken, error) {
	pages, err := a.GetPages(userToken)
	if err != nil {
		return nil, err
	}
	if len(pages) == 0 {
		return nil, fmt.Errorf("no Facebook pages available for this user token")
	}
	if pageID != "" {
		for _, p := range pages {
			if p.PageID == pageID {
				return &p, nil
			}
		}
		return nil, fmt.Errorf("configured PAGE_ID %q not found among manageable pages", pageID)
	}
	return &pages[0], nil
}
