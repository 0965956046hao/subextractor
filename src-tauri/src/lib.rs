mod sidecars;
mod tools;

use sidecars::SidecarManager;
use tauri::Manager;

const LOADING_HTML: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SubTitle Extractor - Setup</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
    }
    .container { text-align: center; max-width: 400px; padding: 40px; }
    .logo { font-size: 48px; margin-bottom: 20px; }
    h1 { font-size: 24px; font-weight: 600; margin-bottom: 8px; }
    .subtitle { font-size: 14px; opacity: 0.8; margin-bottom: 32px; }
    .tools-list { text-align: left; margin-bottom: 32px; }
    .tool-item {
      display: flex; align-items: center; gap: 12px;
      padding: 12px 16px; background: rgba(255,255,255,0.1);
      border-radius: 8px; margin-bottom: 8px; font-size: 14px;
    }
    .tool-icon { width: 20px; text-align: center; }
    .tool-name { flex: 1; font-weight: 500; }
    .tool-status { font-size: 12px; opacity: 0.7; }
    .spinner {
      display: inline-block; width: 16px; height: 16px;
      border: 2px solid rgba(255,255,255,0.3); border-top-color: white;
      border-radius: 50%; animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .checkmark { color: #4ade80; }
    .skip { color: #fbbf24; }
    .error { color: #f87171; }
    .progress-bar {
      height: 4px; background: rgba(255,255,255,0.2);
      border-radius: 2px; overflow: hidden; margin-bottom: 16px;
    }
    .progress-fill {
      height: 100%; background: white; border-radius: 2px;
      transition: width 0.3s ease;
    }
    .message { font-size: 12px; opacity: 0.7; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">🎬</div>
    <h1>SubTitle Extractor</h1>
    <p class="subtitle">Setting up your environment...</p>
    <div class="progress-bar">
      <div class="progress-fill" id="progress" style="width: 0%"></div>
    </div>
    <div class="tools-list">
      <div class="tool-item">
        <span class="tool-icon">🔧</span>
        <span class="tool-name">FFmpeg</span>
        <span class="tool-status" id="s-ffmpeg">Waiting...</span>
      </div>
      <div class="tool-item">
        <span class="tool-icon">🎵</span>
        <span class="tool-name">Demucs</span>
        <span class="tool-status" id="s-demucs">Waiting...</span>
      </div>
      <div class="tool-item">
        <span class="tool-icon">📺</span>
        <span class="tool-name">YouTube Uploader</span>
        <span class="tool-status" id="s-youtubeuploader">Waiting...</span>
      </div>
    </div>
    <p class="message" id="msg">Preparing to install tools...</p>
  </div>
</body>
</html>"#;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SidecarManager::new())
        .setup(|app| {
            let manager = app.state::<SidecarManager>();
            let base = if cfg!(debug_assertions) {
                sidecars::repo_root()
            } else {
                app.path()
                    .resource_dir()
                    .unwrap_or_else(|_| sidecars::repo_root())
            };
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| sidecars::repo_root().join(".data"));

            // Load loading screen: write HTML to data dir and navigate
            if let Some(window) = app.get_webview_window("main") {
                let setup_file = data_dir.join("setup.html");
                if std::fs::write(&setup_file, LOADING_HTML).is_ok() {
                    let url = tauri::Url::parse(&format!("file://{}", setup_file.display()))
                        .expect("valid file url");
                    let _ = window.navigate(url);
                } else {
                    eprintln!("[setup] failed to write setup.html");
                }
            } else {
                eprintln!("[setup] main window not found");
            }

            // First-run tool download (ffmpeg, demucs, youtubeuploader) runs in
            // the background; services resolve them lazily via PATH.
            // Emits "tools-progress" events to frontend for UI feedback.
            tools::ensure_tools(app.handle(), &data_dir);

            for (name, result) in [
                ("backend", manager.spawn_backend(&base, &data_dir)),
                ("capcut", manager.spawn_capcut(&base, &data_dir)),
            ] {
                match result {
                    Ok(()) => println!("[sidecars] {name} started"),
                    Err(e) => eprintln!("[sidecars] failed to start {name}: {e}"),
                }
            }

            #[cfg(not(debug_assertions))]
            {
                match manager.spawn_frontend_prod(&base) {
                    Ok(()) => println!("[sidecars] frontend (next start) started"),
                    Err(e) => eprintln!("[sidecars] failed to start frontend: {e}"),
                }

                // Wait for frontend + backend to be ready
                let frontend_ready = sidecars::wait_for_port(3000, std::time::Duration::from_secs(120));
                let backend_ready = sidecars::wait_for_http(8000, "/api/health", std::time::Duration::from_secs(120));

                // Ensure loading screen shows for at least 2 seconds
                let min_delay = std::time::Duration::from_secs(2);
                let start = std::time::Instant::now();
                let elapsed = start.elapsed();
                if elapsed < min_delay {
                    std::thread::sleep(min_delay - elapsed);
                }

                if frontend_ready && backend_ready {
                    if let Some(window) = app.get_webview_window("main") {
                        let url = tauri::Url::parse("http://localhost:3000")
                            .expect("valid frontend url");
                        if let Err(e) = window.navigate(url) {
                            eprintln!("[sidecars] failed to navigate to frontend: {e}");
                        }
                    }
                } else {
                    eprintln!("[sidecars] services did not become ready in time");
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                tauri::RunEvent::Exit => {
                    if let Some(manager) = app_handle.try_state::<SidecarManager>() {
                        manager.kill_all();
                    }
                }
                tauri::RunEvent::WindowEvent {
                    event: we, ..
                } => {
                    if matches!(we, tauri::WindowEvent::CloseRequested { .. }) {
                        println!("[app] window CloseRequested");
                    }
                }
                _ => {}
            }
        });
}
