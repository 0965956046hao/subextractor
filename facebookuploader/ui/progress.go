package ui

import (
	"fmt"
	"io"
	"os"
	"sync"
)

// ProgressBar renders a terminal progress bar. It is safe to call concurrently.
type ProgressBar struct {
	mu         sync.Mutex
	total      int64
	current    int64
	width      int
	writer     io.Writer
	lastLine   string
}

// NewProgressBar creates a progress bar for total bytes.
func NewProgressBar(total int64) *ProgressBar {
	return &ProgressBar{
		total:  total,
		width:  40,
		writer: os.Stderr,
	}
}

// SetTotal may be called if the total becomes known later.
func (p *ProgressBar) SetTotal(total int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.total = total
}

// Add increments transferred bytes and redraws.
func (p *ProgressBar) Add(n int64) {
	p.mu.Lock()
	p.current += n
	cur := p.current
	total := p.total
	p.mu.Unlock()
	p.draw(cur, total)
}

// Update sets absolute transferred bytes (used by chunk callbacks).
func (p *ProgressBar) Update(transferred, total int64) {
	p.mu.Lock()
	if total > 0 {
		p.total = total
	}
	p.current = transferred
	cur := p.current
	tot := p.total
	p.mu.Unlock()
	p.draw(cur, tot)
}

func (p *ProgressBar) draw(cur, total int64) {
	var pct float64
	if total > 0 {
		pct = float64(cur) / float64(total) * 100
	}
	filled := int(pct / 100 * float64(p.width))
	if filled > p.width {
		filled = p.width
	}
	bar := ""
	for i := 0; i < p.width; i++ {
		if i < filled {
			bar += "█"
		} else {
			bar += " "
		}
	}
	line := fmt.Sprintf("\r[%s] %6.2f%%", bar, pct)
	p.mu.Lock()
	defer p.mu.Unlock()
	// Clear previous line if shorter.
	if len(p.lastLine) > len(line) {
		fmt.Fprint(p.writer, "\r"+line+string(make([]byte, len(p.lastLine)-len(line))))
	} else {
		fmt.Fprint(p.writer, line)
	}
	p.lastLine = line
}

// Finish writes a final newline.
func (p *ProgressBar) Finish() {
	p.mu.Lock()
	defer p.mu.Unlock()
	fmt.Fprintln(p.writer)
}
