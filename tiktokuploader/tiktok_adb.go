package main

import (
	"bufio"
	"encoding/xml"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const tiktokPackage = "com.ss.android.ugc.trill"

// uiNode mirrors a uiautomator window.xml <node>.
type uiNode struct {
	XMLName   xml.Name `xml:"node"`
	Text      string   `xml:"text,attr"`
	Content   string   `xml:"content-desc,attr"`
	Resource  string   `xml:"resource-id,attr"`
	Clickable string   `xml:"clickable,attr"`
	Bounds    string   `xml:"bounds,attr"`
	Nodes     []uiNode `xml:"node"`
}

// center returns the center point of a node's bounds "[x1,y1][x2,y2]".
func (n uiNode) center() (int, int, bool) {
	b := n.Bounds
	b = strings.Trim(b, "[]")
	parts := strings.Split(b, "][")
	if len(parts) != 2 {
		return 0, 0, false
	}
	x1, y1 := splitXY(parts[0])
	x2, y2 := splitXY(parts[1])
	if x1 < 0 || x2 < 0 {
		return 0, 0, false
	}
	return (x1 + x2) / 2, (y1 + y2) / 2, true
}

func splitXY(s string) (int, int) {
	p := strings.Split(s, ",")
	if len(p) != 2 {
		return -1, -1
	}
	x, _ := strconv.Atoi(strings.TrimSpace(p[0]))
	y, _ := strconv.Atoi(strings.TrimSpace(p[1]))
	return x, y
}

// findNode recursively searches for the first node whose text or content-desc
// contains one of the labels.
func findNode(n uiNode, labels []string) *uiNode {
	for _, l := range labels {
		if l == "" {
			continue
		}
		if strings.Contains(n.Text, l) || strings.Contains(n.Content, l) {
			return &n
		}
	}
	for i := range n.Nodes {
		if r := findNode(n.Nodes[i], labels); r != nil {
			return r
		}
	}
	return nil
}

// TikTokADB drives the TikTok Android app via ADB.
type TikTokADB struct {
	adb *ADB
}

func NewTikTokADB(adb *ADB) *TikTokADB {
	return &TikTokADB{adb: adb}
}

func (t *TikTokADB) open() error {
	return t.adb.Shell("monkey", "-p", tiktokPackage, "1")
}

// tapByLabel dumps the UI and taps the center of the first matching element.
// If no match is found and a fallback coordinate is given, taps that instead.
func (t *TikTokADB) tapByLabel(label string, fallbackX, fallbackY int) error {
	xmlStr, err := t.adb.DumpUI()
	if err == nil {
		var root uiNode
		if xml.Unmarshal([]byte(xmlStr), &root) == nil {
			if n := findNode(root, []string{label}); n != nil {
				if x, y, ok := n.center(); ok {
					fmt.Printf("  tap '%s' @ (%d,%d)\n", label, x, y)
					return t.adb.Tap(x, y)
				}
			}
		}
	}
	if fallbackX > 0 {
		fmt.Printf("  tap '%s' (fallback coord %d,%d)\n", label, fallbackX, fallbackY)
		return t.adb.Tap(fallbackX, fallbackY)
	}
	return fmt.Errorf("element '%s' not found and no fallback given", label)
}

// openGalleryApp launches the device's stock Gallery app (Xiaomi MIUI).
func (t *TikTokADB) openGalleryApp() error {
	return t.adb.Shell("monkey", "-p", "com.miui.gallery", "1")
}

// Upload pushes the video to the phone first, opens the device Gallery so the
// user can confirm the file arrived, then shares it to TikTok. Coordinates are
// tuned for Xiaomi 15T Pro (1280x2772). TikTok renders its UI via OpenGL so
// uiautomator cannot see element text; we use fixed taps.
func (t *TikTokADB) Upload(videoPath, caption string) error {
	remote := "/sdcard/DCIM/tiktok_upload.mp4"
	fmt.Println("Pushing video to phone:", videoPath)
	if err := t.adb.Push(videoPath, remote); err != nil {
		return err
	}
	fmt.Println("Video pushed.")

	fmt.Println("Opening device Gallery so you can verify the video...")
	if err := t.openGalleryApp(); err != nil {
		return err
	}
	time.Sleep(4 * time.Second)

	fmt.Print("Has the video appeared in the Gallery? (y/N): ")
	reader := bufio.NewReader(os.Stdin)
	answer, _ := reader.ReadString('\n')
	answer = strings.TrimSpace(strings.ToLower(answer))
	if answer != "y" && answer != "yes" {
		fmt.Println("Aborted by user — video not confirmed in Gallery.")
		return fmt.Errorf("user did not confirm video in Gallery")
	}

	// First video — top-left grid cell in the Gallery.
	if err := t.adb.Tap(126, 795); err != nil {
		return err
	}
	time.Sleep(2 * time.Second)

	// "Gửi" (Share) — bottom-left of the Gallery viewer.
	if err := t.adb.Tap(135, 2644); err != nil {
		return err
	}
	time.Sleep(2 * time.Second)

	// TikTok in the share sheet.
	if err := t.adb.Tap(783, 2400); err != nil {
		return err
	}
	time.Sleep(4 * time.Second)

	// "Video" button on the "Chia sẻ lên TikTok" screen.
	if err := t.adb.Tap(362, 2385); err != nil {
		return err
	}
	time.Sleep(4 * time.Second)

	// "Tiếp" (Next) on the edit screen — bottom-right.
	if err := t.adb.Tap(943, 2612); err != nil {
		return err
	}
	time.Sleep(4 * time.Second)

	// Caption field ("Thêm mô tả...") — upper area of the post screen.
	// NOTE: TikTok's EditText ignores clipboard-paste (keyevent 279), so we
	// type via `input text`. This works for ASCII; accented Vietnamese must be
	// pre-transliterated or entered another way.
	if caption != "" {
		fmt.Printf("Setting caption: %q\n", caption)
		if err := t.adb.Tap(414, 574); err != nil {
			return err
		}
		time.Sleep(800 * time.Millisecond)
		if err := t.adb.Text(caption); err != nil {
			return err
		}
		time.Sleep(1 * time.Second)
	}

	// "Đăng" (Post) — bottom-right of the post screen.
	if err := t.adb.Tap(947, 2603); err != nil {
		return err
	}
	time.Sleep(3 * time.Second)

	// Privacy modal: choose "Chỉ mình bạn" (Self only).
	if err := t.adb.Tap(325, 2459); err != nil {
		return err
	}
	time.Sleep(2 * time.Second)

	fmt.Println("TikTok post action executed.")
	return nil
}
