package main

import (
	"context"
	"fmt"
	"os"

	"github.com/tinh/facebook-uploader/cmd"
)

func main() {
	if err := cmd.Execute(context.Background()); err != nil {
		if cmd.IsHelpErr(err) {
			return
		}
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}
