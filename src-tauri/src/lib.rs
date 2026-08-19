mod sidecars;
mod tools;

use sidecars::SidecarManager;
use tauri::Manager;

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

            // First-run tool download (ffmpeg, demucs, youtubeuploader) runs in
            // the background; services resolve them lazily via PATH.
            tools::ensure_tools(&data_dir);

            for (name, result) in [
                ("backend", manager.spawn_backend(&base, &data_dir)),
                ("ds2api", manager.spawn_ds2api(&base, &data_dir)),
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

                if sidecars::wait_for_port(3000, std::time::Duration::from_secs(120)) {
                    // Wait for the backend to actually serve requests, so the
                    // frontend's first API calls don't race a warming OCR engine.
                    if sidecars::wait_for_http(8000, "/api/health", std::time::Duration::from_secs(120)) {
                        if let Some(window) = app.get_webview_window("main") {
                            let url = tauri::Url::parse("http://localhost:3000")
                                .expect("valid frontend url");
                            if let Err(e) = window.navigate(url) {
                                eprintln!("[sidecars] failed to navigate to frontend: {e}");
                            }
                        }
                    } else {
                        eprintln!("[sidecars] backend did not become ready on :8000");
                    }
                } else {
                    eprintln!("[sidecars] frontend did not become ready on :3000");
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
