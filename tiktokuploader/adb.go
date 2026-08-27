package main

import (
	"bytes"
	"fmt"
	"os/exec"
	"strings"
)

// ADB wraps adb command-line invocations for a specific device.
type ADB struct {
	Serial string
}

// run executes an adb command (with -s serial when set) and returns stdout.
func (a *ADB) run(args ...string) ([]byte, error) {
	base := []string{}
	if a.Serial != "" {
		base = append(base, "-s", a.Serial)
	}
	base = append(base, args...)

	cmd := exec.Command("adb", base...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("adb error: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}

// Shell runs an adb shell command, discarding output.
func (a *ADB) Shell(args ...string) error {
	_, err := a.run(append([]string{"shell"}, args...)...)
	return err
}

// ShellOutput runs an adb shell command and returns its stdout.
func (a *ADB) ShellOutput(args ...string) (string, error) {
	out, err := a.run(append([]string{"shell"}, args...)...)
	return string(out), err
}

// Push copies a local file to a remote path on the device.
func (a *ADB) Push(local, remote string) error {
	_, err := a.run("push", local, remote)
	return err
}

// Tap performs a tap at (x, y).
func (a *ADB) Tap(x, y int) error {
	return a.Shell("input", "tap", fmt.Sprintf("%d", x), fmt.Sprintf("%d", y))
}

// Swipe performs a swipe from (x1,y1) to (x2,y2) over duration ms.
func (a *ADB) Swipe(x1, y1, x2, y2, duration int) error {
	return a.Shell("input", "swipe",
		fmt.Sprintf("%d", x1), fmt.Sprintf("%d", y1),
		fmt.Sprintf("%d", x2), fmt.Sprintf("%d", y2),
		fmt.Sprintf("%d", duration))
}

// Keyevent sends an Android keyevent (e.g. "KEYCODE_BACK").
func (a *ADB) Keyevent(key string) error {
	return a.Shell("input", "keyevent", key)
}

// Text types UTF-8 text. Spaces are encoded as %s (ADB convention).
func (a *ADB) Text(text string) error {
	escaped := strings.ReplaceAll(text, " ", "%s")
	escaped = strings.ReplaceAll(escaped, "'", "\\'")
	return a.Shell("input", "text", escaped)
}

// SetClipboard stores text on the device clipboard (supports UTF-8 / accents).
func (a *ADB) SetClipboard(text string) error {
	return a.Shell("cmd", "clipboard", "set", text)
}

// Paste sends KEYCODE_PASTE (279) to insert the current clipboard contents
// into the focused text field.
func (a *ADB) Paste() error {
	return a.Shell("input", "keyevent", "279")
}

// DumpUI runs uiautomator dump and returns the XML window hierarchy.
func (a *ADB) DumpUI() (string, error) {
	if err := a.Shell("uiautomator", "dump", "/sdcard/window.xml"); err != nil {
		return "", err
	}
	return a.ShellOutput("cat", "/sdcard/window.xml")
}
