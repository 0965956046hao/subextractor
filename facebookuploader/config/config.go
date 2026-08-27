package config

import (
	"fmt"
	"os"
	"strconv"

	"github.com/joho/godotenv"
)

// Config holds all credentials and tunables for the uploader.
//
// SECURITY: secrets are read from environment / .env only and are NEVER printed
// to stdout or logs.
type Config struct {
	AppID             string
	AppSecret         string
	PageID            string
	PageAccessToken   string
	GraphAPIVersion   string
	TokenStorePath    string
	DefaultPublish    bool
}

// APIBase returns the base URL for the configured Graph API version.
func (c *Config) APIBase() string {
	if c.GraphAPIVersion == "" {
		return "https://graph.facebook.com/v21.0"
	}
	return "https://graph.facebook.com/" + c.GraphAPIVersion
}

// Load reads configuration from .env (if present) then from the real
// environment, so explicit environment variables take precedence.
func Load() (*Config, error) {
	// Best-effort load of a local .env; ignore if missing.
	_ = godotenv.Load()

	c := &Config{
		AppID:           getEnv("FACEBOOK_APP_ID"),
		AppSecret:       getEnv("FACEBOOK_APP_SECRET"),
		PageID:          getEnv("FACEBOOK_PAGE_ID"),
		PageAccessToken: getEnv("FACEBOOK_PAGE_ACCESS_TOKEN"),
		GraphAPIVersion: getEnv("FACEBOOK_GRAPH_API_VERSION"),
	}

	if c.GraphAPIVersion == "" {
		c.GraphAPIVersion = "v21.0"
	}

	if v := getEnv("FACEBOOK_DEFAULT_PUBLISH"); v != "" {
		b, err := strconv.ParseBool(v)
		if err == nil {
			c.DefaultPublish = b
		}
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("cannot determine home directory: %w", err)
	}
	c.TokenStorePath = getEnv("FACEBOOK_TOKEN_STORE")
	if c.TokenStorePath == "" {
		c.TokenStorePath = home + "/.config/facebook-uploader/tokens.json"
	}

	return c, nil
}

func getEnv(key string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return ""
}

// ValidateApp checks that the app-level credentials required for OAuth are set.
func (c *Config) ValidateApp() error {
	if c.AppID == "" {
		return fmt.Errorf("FACEBOOK_APP_ID is not set (add it to .env or environment)")
	}
	if c.AppSecret == "" {
		return fmt.Errorf("FACEBOOK_APP_SECRET is not set (add it to .env or environment)")
	}
	return nil
}
