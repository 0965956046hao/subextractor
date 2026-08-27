package cmd

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/tinh/facebook-uploader/facebook"
	"github.com/tinh/facebook-uploader/models"
)

func runBatch(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("batch", flag.ContinueOnError)
	dir := fs.String("dir", "", "Directory containing videos")
	description := fs.String("description", "", "Description template (appended per file)")
	publish := fs.Bool("publish", false, "Publish immediately")
	jsonOut := fs.Bool("json", false, "Output JSON to stdout")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *dir == "" {
		return fmt.Errorf("--dir is required")
	}

	cfg := loadConfigOrExit()
	if !*publish && cfg.DefaultPublish {
		*publish = true
	}
	pageID, token, err := resolvePageToken(ctx, cfg)
	if err != nil {
		return err
	}
	client := newClient(cfg)

	files, err := collectVideos(*dir)
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return fmt.Errorf("no video files found in %s", *dir)
	}

	records := make([]models.JobRecord, 0, len(files))
	for i, f := range files {
		fmt.Printf("[%d/%d] %s\n", i+1, len(files), filepath.Base(f))
		desc := *description
		res, upErr := client.UploadVideoPage(facebook.VideoUploadOptions{
			PageID:      pageID,
			AccessToken: token,
			FilePath:    f,
			Description: desc,
			Publish:     *publish,
		})
		rec := models.JobRecord{File: f}
		if upErr != nil {
			rec.Status = "FAILED"
			rec.Error = upErr.Error()
			if apiErr, ok := upErr.(*facebook.APIError); ok {
				rec.Error = apiErr.ToModel().Code
			}
		} else {
			rec.Status = res.Status
			rec.VideoID = res.VideoID
		}
		records = append(records, rec)
		fmt.Printf("   -> %s\n", rec.Status)
	}

	outPath := "data/jobs.json"
	if err := saveJobs(outPath, records); err != nil {
		return fmt.Errorf("save jobs: %w", err)
	}
	fmt.Printf("\nSaved results to %s\n", outPath)

	if *jsonOut {
		b, _ := json.Marshal(map[string]interface{}{"success": true, "platform": "facebook", "jobs": records})
		fmt.Println(string(b))
	}
	return nil
}

// collectVideos returns sorted video file paths in dir.
func collectVideos(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read dir: %w", err)
	}
	exts := map[string]bool{".mp4": true, ".mov": true, ".m4v": true, ".webm": true, ".avi": true, ".mkv": true}
	out := make([]string, 0)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		ext := filepath.Ext(e.Name())
		if exts[ext] {
			out = append(out, filepath.Join(dir, e.Name()))
		}
	}
	sort.Strings(out)
	return out, nil
}

func saveJobs(path string, records []models.JobRecord) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}
