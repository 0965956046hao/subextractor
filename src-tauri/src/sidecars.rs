#[cfg(not(debug_assertions))]
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
#[cfg(not(debug_assertions))]
use std::time::{Duration, Instant};

pub struct SidecarManager {
    children: Mutex<Vec<Child>>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            children: Mutex::new(Vec::new()),
        }
    }

    fn spawn(&self, mut cmd: Command) -> Result<(), String> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            unsafe {
                cmd.pre_exec(|| {
                    libc::setpgid(0, 0);
                    Ok(())
                });
            }
        }

        let child = cmd.spawn().map_err(|e| e.to_string())?;
        self.children.lock().unwrap().push(child);
        Ok(())
    }

    pub fn spawn_backend(&self, base: &Path, data_dir: &Path) -> Result<(), String> {
        let mut cmd = if resolve(base, "backend/backend").is_file() {
            let mut c = Command::new(resolve(base, "backend/backend"));
            c.current_dir(resolve(base, "backend"))
                .env("STE_HOST", "127.0.0.1")
                .env("STE_PORT", "8000");
            c
        } else {
            let mut c = Command::new(resolve(base, "backend/.venv/bin/uvicorn"));
            c.args(["app.main:app", "--host", "127.0.0.1", "--port", "8000"])
                .current_dir(resolve(base, "backend"));
            c
        };
        let tools = crate::tools::tools_dir(base, data_dir);
        let demucs = tools.join("demucs");
        let path = std::env::var("PATH").unwrap_or_default();
        cmd.env(
            "PATH",
            format!("{}:{}:{}", tools.display(), demucs.display(), path),
        );
        cmd.env("STE_BASE_DIR", data_dir);
        let yt_dir = data_dir.join("youtube");
        std::fs::create_dir_all(&yt_dir).map_err(|e| e.to_string())?;
        let secrets = yt_dir.join("client_secrets.json");
        if !secrets.exists() {
            let template = resolve(base, "youtubeuploader.client_secrets.json");
            if template.is_file() {
                let _ = std::fs::copy(&template, &secrets);
            }
        }
        self.spawn(cmd)
    }

    pub fn spawn_ds2api(&self, base: &Path, data_dir: &Path) -> Result<(), String> {
        let dir = resolve(base, "ds2api");
        let bin = dir.join("ds2api");
        if !bin.exists() {
            let status = Command::new("go")
                .args(["build", "-o", "ds2api", "./cmd/ds2api"])
                .current_dir(&dir)
                .status()
                .map_err(|e| e.to_string())?;
            if !status.success() {
                return Err("go build ds2api failed".into());
            }
        }

        let cfg_dir = data_dir.join("ds2api");
        std::fs::create_dir_all(&cfg_dir).map_err(|e| e.to_string())?;
        let cfg_path = cfg_dir.join("config.json");
        if !cfg_path.exists() {
            let example = dir.join("config.example.json");
            if example.exists() {
                let _ = std::fs::copy(&example, &cfg_path);
            }
        }

        let mut cmd = Command::new(&bin);
        cmd.current_dir(&dir)
            .env("PORT", "5001")
            .env("DS2API_ADMIN_KEY", "test-admin")
            .env("DS2API_CONFIG_PATH", &cfg_path);
        self.spawn(cmd)
    }

    pub fn spawn_capcut(&self, base: &Path, data_dir: &Path) -> Result<(), String> {
        let mut cmd = if resolve(base, "capcut-tts-api/capcut-tts-api").is_file() {
            let mut c = Command::new(resolve(base, "capcut-tts-api/capcut-tts-api"));
            c.current_dir(resolve(base, "capcut-tts-api"))
                .env("CTTS_HOST", "127.0.0.1")
                .env("CTTS_PORT", "8100");
            c
        } else {
            let mut c = Command::new(resolve(base, "backend/.venv/bin/python"));
            c.args(["-m", "service.main"])
                .current_dir(resolve(base, "capcut-tts-api"));
            c
        };
        cmd.env("CTTS_BASE_DIR", data_dir);
        self.spawn(cmd)
    }

    #[cfg(not(debug_assertions))]
    pub fn spawn_frontend_prod(&self, base: &Path) -> Result<(), String> {
        let standalone = resolve(base, "frontend/.next/standalone");
        let mut cmd = Command::new(resolve(base, "node/bin/node"));
        cmd.arg(standalone.join("server.js"))
            .current_dir(&standalone)
            .env("HOSTNAME", "127.0.0.1")
            .env("PORT", "3000");
        self.spawn(cmd)
    }

    pub fn kill_all(&self) {
        let mut children = self.children.lock().unwrap();
        for child in children.iter_mut() {
            let pid = child.id();
            #[cfg(unix)]
            unsafe {
                libc::killpg(pid as i32, libc::SIGTERM);
            }
            #[cfg(not(unix))]
            let _ = child.kill();
        }
        for child in children.iter_mut() {
            let _ = child.wait();
        }
        children.clear();
    }
}

#[cfg(not(debug_assertions))]
pub fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    loop {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        if start.elapsed() > timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Wait until an HTTP endpoint on 127.0.0.1:port actually answers 200 (a raw
/// TCP connect succeeds before uvicorn finishes its startup lifespan, so this
/// is needed to avoid racing a still-warming backend).
#[cfg(not(debug_assertions))]
pub fn wait_for_http(port: u16, path: &str, timeout: Duration) -> bool {
    use std::io::{Read, Write};
    let start = Instant::now();
    let req = format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n");
    loop {
        if let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) {
            if s.write_all(req.as_bytes()).is_ok() {
                let mut buf = [0u8; 4096];
                if let Ok(n) = s.read(&mut buf) {
                    let head = String::from_utf8_lossy(&buf[..n]);
                    if head.contains("200 OK") {
                        return true;
                    }
                }
            }
        }
        if start.elapsed() > timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

pub fn repo_root() -> PathBuf {
    if let Ok(root) = std::env::var("STE_ROOT") {
        return PathBuf::from(root);
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if cwd.file_name().and_then(|s| s.to_str()) == Some("src-tauri") {
        cwd.parent().unwrap_or(&cwd).to_path_buf()
    } else {
        cwd
    }
}

fn resolve(base: &Path, rel: &str) -> PathBuf {
    let bundled = base.join(rel);
    if bundled.exists() {
        bundled
    } else {
        repo_root().join(rel)
    }
}
