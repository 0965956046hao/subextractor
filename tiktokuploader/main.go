package main

import (
	"flag"
	"fmt"
	"log"
	"os"
)

func main() {
	video := flag.String("video", "", "Local video path to push & post")
	caption := flag.String("caption", "", "Caption text")
	serial := flag.String("serial", "", "ADB device serial (omit if only one device)")
	flag.Parse()

	if *video == "" {
		fmt.Println("usage: tiktok-uploader -video <video.mp4> [-caption C] [-serial S]")
		os.Exit(1)
	}
	if _, err := os.Stat(*video); err != nil {
		log.Fatalf("video not found: %v", err)
	}

	adb := &ADB{Serial: *serial}
	uploader := NewTikTokADB(adb)
	if err := uploader.Upload(*video, *caption); err != nil {
		log.Fatalf("post failed: %v", err)
	}
	fmt.Println("Upload workflow completed")
}
