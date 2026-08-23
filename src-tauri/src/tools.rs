use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::command;

struct ToolSpec {
    name: &'static str,
    archive: &'static str,
    display: &'static str,
}

const TOOLS: &[ToolSpec] = &[
    ToolSpec { name: "ffmpeg",          archive: "ffmpeg.tar.gz",          display: "FFmpeg" },
    ToolSpec { name: "demucs",          archive: "demucs.tar.gz",          display: "Demucs" },
    ToolSpec { name: "youtubeuploader", archive: "youtubeuploader.tar.gz", display: "YouTube Uploader" },
];

#[derive(Clone, serde::Serialize)]
pub struct ToolStatus {
    name: String,
    display: String,
    installed: bool,
}

#[derive(Clone, serde::Serialize)]
pub struct InstallLog {
    tool: String,
    status: String,
    message: String,
}

fn app_resource_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let res = exe.parent()?.join("../Resources");
    if res.is_dir() { Some(res) } else { None }
}

fn tools_dir_from_exe() -> PathBuf {
    if cfg!(debug_assertions) {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(root) = exe.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
                let dev = root.join("src-tauri/resources/tools");
                if dev.join("ffmpeg").is_file() {
                    return dev;
                }
            }
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("../../tools")
}

fn data_dir_from_exe() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("../..")
}

fn system_tool_exists(name: &str) -> bool {
    Command::new("which")
        .arg(name)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn is_tool_installed(spec: &ToolSpec, tools_dir: &Path) -> bool {
    let marker = tools_dir.join(format!(".{}.installed", spec.name));
    let in_dir = tools_dir.join(spec.name).is_file();
    let in_dir_demucs = spec.name == "demucs" && tools_dir.join("demucs").is_dir();
    let in_path = system_tool_exists(spec.name);
    marker.exists() || in_dir || in_dir_demucs || in_path
}

#[command]
pub fn check_tools() -> Vec<ToolStatus> {
    let tools_dir = tools_dir_from_exe();
    TOOLS.iter().map(|spec| {
        ToolStatus {
            name: spec.name.to_string(),
            display: spec.display.to_string(),
            installed: is_tool_installed(spec, &tools_dir),
        }
    }).collect()
}

#[command]
pub fn install_tools() -> Result<Vec<InstallLog>, String> {
    let tools_dir = tools_dir_from_exe();
    let data_dir = data_dir_from_exe();
    std::fs::create_dir_all(&tools_dir).map_err(|e| e.to_string())?;

    let resource_dir = app_resource_dir()
        .ok_or("Cannot locate app resources (not running from bundle?)")?;

    let mut logs: Vec<InstallLog> = Vec::new();

    for spec in TOOLS {
        let marker = tools_dir.join(format!(".{}.installed", spec.name));

        logs.push(InstallLog {
            tool: spec.name.to_string(),
            status: "checking".to_string(),
            message: format!("Kiểm tra {}...", spec.display),
        });

        if is_tool_installed(spec, &tools_dir) {
            logs.push(InstallLog {
                tool: spec.name.to_string(),
                status: "exists".to_string(),
                message: format!("{} đã có sẵn", spec.display),
            });
            let _ = std::fs::write(&marker, "1");
            continue;
        }

        let archive = resource_dir.join("tools-archive").join(spec.archive);
        if !archive.is_file() {
            logs.push(InstallLog {
                tool: spec.name.to_string(),
                status: "error".to_string(),
                message: format!("{}: không tìm thấy archive {}", spec.display, spec.archive),
            });
            continue;
        }

        logs.push(InstallLog {
            tool: spec.name.to_string(),
            status: "extracting".to_string(),
            message: format!("Đang giải nén {}...", spec.display),
        });

        let result = Command::new("tar")
            .args(["-xzf"])
            .arg(&archive)
            .current_dir(&tools_dir)
            .status();

        match result {
            Ok(s) if s.success() => {
                let _ = std::fs::write(&marker, "1");
                logs.push(InstallLog {
                    tool: spec.name.to_string(),
                    status: "done".to_string(),
                    message: format!("{} cài xong", spec.display),
                });
            }
            _ => {
                logs.push(InstallLog {
                    tool: spec.name.to_string(),
                    status: "error".to_string(),
                    message: format!("{}: giải nén thất bại", spec.display),
                });
            }
        }
    }

    let data_tools = data_dir.join("tools");
    if data_tools != tools_dir {
        let _ = std::fs::create_dir_all(&data_tools);
        for spec in TOOLS {
            let src_marker = tools_dir.join(format!(".{}.installed", spec.name));
            let dst_marker = data_tools.join(format!(".{}.installed", spec.name));
            if src_marker.exists() && !dst_marker.exists() {
                let _ = std::fs::copy(&src_marker, &dst_marker);
            }
        }
    }

    Ok(logs)
}

pub fn tools_dir(base: &Path, data_dir: &Path) -> PathBuf {
    if cfg!(debug_assertions) {
        let dev = base.join("src-tauri/resources/tools");
        if dev.join("ffmpeg").is_file() {
            return dev;
        }
    }
    data_dir.join("tools")
}
