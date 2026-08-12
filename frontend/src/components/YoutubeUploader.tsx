"use client";

import { useState, useCallback, useEffect } from "react";
import Link from "next/link";
import { AnimatedBlock } from "@/lib/animation";

interface FileList {
  path: string;
  videos: string[];
  images: string[];
}

interface MetaData {
  title: string;
  description: string;
  tags: string[];
  hashtags: string[];
  episode: number;
  original_title: string;
  original_description: string;
}

function IconSparkle({ className = "w-4 h-4" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3z" />
      <path d="M5 19l.5-2L7 17l-1.5-.5L5 16l-.5 2L3 18l2 .5L5 19z" />
    </svg>
  );
}

function IconSpinner({ className = "w-4 h-4" }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" opacity="0.15" />
      <path d="M12 2a10 10 0 019.95 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconUpload({ className = "w-4 h-4" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function IconCheck({ className = "w-4 h-4" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function IconError({ className = "w-4 h-4" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  );
}

export default function YoutubeUploader() {
  // Step state
  const [folderPath, setFolderPath] = useState("/Users/phantrongtinh/Documents/video/subextractor/youtubeuploader/video_capcut");
  const [files, setFiles] = useState<FileList | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);

  // Selection
  const [selectedVideo, setSelectedVideo] = useState("");
  const [selectedThumb, setSelectedThumb] = useState("");
  const [customThumb, setCustomThumb] = useState<File | null>(null);
  const [customThumbPreview, setCustomThumbPreview] = useState("");

  // Meta input
  const [rawInput, setRawInput] = useState("");
  const [meta, setMeta] = useState<MetaData | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");

  // Upload
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState("");
  const [privacy, setPrivacy] = useState("private");
  const [uploadJobId, setUploadJobId] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadLines, setUploadLines] = useState<string[]>([]);

  // Saved meta path
  const [savedMetaPath, setSavedMetaPath] = useState("");

  // YouTube config
  const [config, setConfig] = useState({ has_client_secrets: false, has_request_token: false, has_binary: false });
  const [showConfig, setShowConfig] = useState(false);
  const [secretsContent, setSecretsContent] = useState("");
  const [savingConfig, setSavingConfig] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/youtube/config");
      const data = await res.json();
      setConfig(data);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const saveSecrets = async () => {
    if (!secretsContent.trim()) return;
    setSavingConfig(true);
    try {
      await fetch("/api/youtube/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: secretsContent }),
      });
      await loadConfig();
      setShowConfig(false);
    } catch {
      // ignore
    }
    setSavingConfig(false);
  };

  const setupEnvironment = async () => {
    setSavingConfig(true);
    try {
      const res = await fetch("/api/youtube/setup", { method: "POST" });
      const data = await res.json();
      if (data.status === "success") {
        await loadConfig();
      }
      setUploadResult(data.output?.join?.("\\n") || data.error || "Done");
    } catch {
      setUploadResult("Setup failed");
    }
    setSavingConfig(false);
  };

  const loadFolderWithPath = useCallback(async (path: string) => {
    if (!path.trim()) return;
    setLoadingFiles(true);
    setFiles(null);
    try {
      const res = await fetch("/api/youtube/list-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setFiles(data);
        if (data.videos.length > 0) setSelectedVideo(data.videos[0]);
        if (data.images.length > 0) setSelectedThumb(data.images[0]);
      }
    } catch {
      // ignore
    }
    setLoadingFiles(false);
  }, []);

  const loadFolder = useCallback(async () => {
    await loadFolderWithPath(folderPath);
  }, [folderPath, loadFolderWithPath]);

  const generateMeta = async () => {
    setGenerating(true);
    setGenError("");
    try {
      const res = await fetch("/api/youtube/generate-meta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw_input: rawInput }),
      });
      const data = await res.json();
      if (res.ok && data.meta) {
        setMeta(data.meta);
      } else {
        setGenError(data.detail || "Failed to generate meta");
      }
    } catch {
      setGenError("Connection error");
    }
    setGenerating(false);
  };

  const saveMetaFile = async () => {
    if (!meta || !files) return;
    // Save to the same folder as videos, in a "meta" subfolder
    const metaDir = files.path + "/../meta";
    const metaFileName = selectedVideo.replace(/\.(mov|mp4)$/i, ".json");

    try {
      const res = await fetch("/api/youtube/save-meta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folder: metaDir,
          filename: metaFileName,
          meta: meta,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setSavedMetaPath(data.path);
      }
    } catch {
      // ignore
    }
  };

  const handleUpload = async () => {
    if (!files || !selectedVideo || !savedMetaPath) return;
    setUploading(true);
    setUploadResult("");
    setUploadProgress(0);
    setUploadLines([]);
    try {
      const videoPath = files.path + "/" + selectedVideo;
      let thumbPath = selectedThumb ? files.path + "/" + selectedThumb : "";
      // Upload custom thumbnail if selected
      if (customThumb) {
        const form = new FormData();
        form.append("file", customThumb);
        form.append("folder", files.path);
        const upRes = await fetch("/api/youtube/upload-thumbnail", { method: "POST", body: form });
        const upData = await upRes.json();
        if (upData.path) thumbPath = upData.path;
      }
      const res = await fetch("/api/youtube/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          video_path: videoPath,
          meta_path: savedMetaPath,
          thumbnail_path: thumbPath,
          privacy: privacy,
        }),
      });
      const data = await res.json();
      if (data.job_id) {
        setUploadJobId(data.job_id);
      } else {
        setUploading(false);
        setUploadResult("Failed to start upload");
      }
    } catch {
      setUploading(false);
      setUploadResult("Connection error");
    }
  };

  // Poll upload job status
  useEffect(() => {
    if (!uploadJobId) return;
    const poll = async () => {
      try {
        const res = await fetch(`/api/youtube/upload/${uploadJobId}`);
        const data = await res.json();
        setUploadProgress(data.progress || 0);
        setUploadLines(data.output_lines || []);
        if (data.status === "done") {
          setUploading(false);
          setUploadJobId(null);
          setUploadResult("Upload thành công!");
          setUploadProgress(100);
        } else if (data.status === "error") {
          setUploading(false);
          setUploadJobId(null);
          setUploadResult(data.error || "Upload failed");
        }
      } catch {
        // ignore
      }
    };
    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  }, [uploadJobId]);

  return (
    <main className="min-h-[100dvh] max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12 md:py-16">
      <AnimatedBlock delay={0}>
        <Link href="/" className="btn-island-secondary group !px-5 !py-2 text-[13px]">
          <span className="btn-island-icon !w-7 !h-7">
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5" /><path d="M11 18l-6-6 6-6" />
            </svg>
          </span>
          <span className="tracking-tight">Back to library</span>
        </Link>
      </AnimatedBlock>

      <AnimatedBlock delay={100} className="mt-10 mb-10">
        <div className="eyebrow mb-4">YouTube Uploader</div>
        <h1 className="text-[clamp(1.8rem,4.5vw,3.4rem)] font-semibold tracking-tight leading-[1.05] text-ink">
          Upload Video to YouTube
        </h1>
      </AnimatedBlock>

      {/* Config Status */}
      <AnimatedBlock delay={150}>
        <div className="glass-panel rounded-2xl px-4 py-3 mb-6 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className={`w-2 h-2 rounded-full ${config.has_client_secrets ? "bg-emerald-500" : "bg-red-500"} animate-pulse`} />
            <span className="text-[12px] font-medium text-ink-muted">
              {config.has_client_secrets ? "YouTube API đã cấu hình" : "Chưa cấu hình YouTube API"}
            </span>
            {config.has_request_token && (
              <span className="text-[11px] text-emerald-600/70">(đã xác thực)</span>
            )}
            {!config.has_binary && (
              <button
                onClick={setupEnvironment}
                disabled={savingConfig}
                className="px-3 py-1 rounded-full text-[10px] font-medium bg-amber-500/10 text-amber-700 ring-1 ring-amber-500/20 hover:bg-amber-500/20 transition-all duration-300 active:scale-[0.97] cursor-pointer"
              >
                {savingConfig ? "Đang cài..." : "Cài đặt môi trường"}
              </button>
            )}
          </div>
          <button
            onClick={() => {
              setShowConfig(!showConfig);
              if (!showConfig) loadConfig();
            }}
            className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-black/[0.03] ring-1 ring-black/[0.06] hover:bg-black/[0.06] transition-all duration-300 cursor-pointer"
          >
            {showConfig ? "Đóng" : "Cấu hình"}
          </button>
        </div>

        {showConfig && (
          <div className="double-bezel mb-6" style={{ animation: "fade-up 0.3s ease forwards" }}>
            <div className="double-bezel-inner p-4 sm:p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-ink-muted mb-3">
                Cấu hình YouTube API
              </p>
              <p className="text-[12px] text-ink-muted mb-3">
                Dán nội dung file <code className="text-[11px] bg-black/[0.04] px-1 py-0.5 rounded">client_secrets.json</code> từ Google Cloud Console.
              </p>

              <details className="mb-3">
                <summary className="text-[11px] font-medium text-blue-600/80 cursor-pointer hover:text-blue-700">
                  📖 Hướng dẫn tạo client_secrets.json
                </summary>
                <div className="mt-2 text-[11px] text-ink-muted leading-relaxed space-y-1.5 p-3 rounded-xl bg-black/[0.015]">
                  <p className="font-medium text-ink/70">1. Truy cập <a href="https://console.developers.google.com" target="_blank" className="text-blue-500 underline">Google Developers Console</a></p>
                  <p className="font-medium text-ink/70">2. Tạo project mới cho ứng dụng này</p>
                  <p className="font-medium text-ink/70">3. Bật YouTube API:</p>
                  <p className="ml-3">APIs &amp; Services → Enable APIs and Services → tìm &quot;YouTube Data API v3&quot; → Enable</p>
                  <p className="font-medium text-ink/70">4. Tạo OAuth consent screen:</p>
                  <p className="ml-3">APIs &amp; Services → OAuth Consent Screen → thêm Test User (tài khoản Google sẽ đăng video lên)</p>
                  <p className="font-medium text-ink/70">5. Tạo Credentials:</p>
                  <p className="ml-3">APIs &amp; Services → Credentials → Create Credentials → OAuth client ID → Web application</p>
                  <p className="ml-3">Thêm <code className="text-[10px] bg-black/[0.06] px-1 py-0.5 rounded">Authorized redirect URI</code>: <span className="font-mono text-blue-600/80">http://localhost:8080/oauth2callback</span></p>
                  <p className="font-medium text-ink/70">6. Tải file JSON về và dán nội dung vào đây</p>
                  <p className="text-[10px] text-ink-light mt-2">Lưu ý: file phải có định dạng {"{ \"web\": { \"client_id\": \"...\", ... } }"} (OAuth Web Application)</p>
                </div>
              </details>
              <textarea
                value={secretsContent}
                onChange={(e) => setSecretsContent(e.target.value)}
                placeholder='{"installed":{"client_id":"...","project_id":"...","auth_uri":"...","token_uri":"...","auth_provider_x509_cert_url":"...","client_secret":"...","redirect_uris":["..."]}}'
                rows={5}
                className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-[12px] text-ink font-mono resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
              <button
                onClick={saveSecrets}
                disabled={savingConfig || !secretsContent.trim()}
                className="mt-2 px-4 py-1.5 rounded-full text-[12px] font-medium bg-blue-600 text-white hover:bg-blue-500 transition-all duration-300 active:scale-[0.97] cursor-pointer disabled:opacity-50"
              >
                {savingConfig ? "Đang lưu..." : "Lưu cấu hình"}
              </button>
            </div>
          </div>
        )}
      </AnimatedBlock>

      {/* Step 1: Select Folder */}
      <AnimatedBlock delay={200}>
        <div className="double-bezel mb-6">
          <div className="double-bezel-inner p-5 sm:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-ink-muted mb-3">
              1. Chọn thư mục chứa video
            </p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && loadFolder()}
                placeholder="/path/to/video/folder"
                className="flex-1 rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
              <button
                onClick={loadFolder}
                disabled={loadingFiles}
                className="px-5 py-2 rounded-full text-[12px] font-medium bg-blue-600 text-white hover:bg-blue-500 transition-all duration-300 active:scale-[0.97] cursor-pointer disabled:opacity-60 flex-shrink-0"
              >
                {loadingFiles ? <IconSpinner className="w-3.5 h-3.5" /> : "Duyệt"}
              </button>
              <button
                onClick={async () => {
                  try {
                    const res = await fetch("/api/youtube/pick-folder", { method: "POST" });
                    const data = await res.json();
                    if (data.path) {
                      setFolderPath(data.path);
                      loadFolderWithPath(data.path);
                    }
                  } catch {
                    // ignore
                  }
                }}
                title="Mở hộp thoại chọn thư mục"
                className="px-4 py-2 rounded-full text-[12px] font-medium bg-black/[0.03] ring-1 ring-black/[0.06] text-ink-muted hover:bg-black/[0.06] hover:text-ink transition-all duration-300 active:scale-[0.97] cursor-pointer flex-shrink-0"
              >
                Chọn folder
              </button>
            </div>

            {files && (
              <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Video list */}
                <div>
                  <p className="text-[11px] font-medium text-ink-muted mb-2">
                    Videos ({files.videos.length})
                  </p>
                  <div className="max-h-[200px] overflow-y-auto space-y-1 rounded-xl bg-black/[0.015] p-2">
                    {files.videos.map((v) => (
                      <button
                        key={v}
                        onClick={() => setSelectedVideo(v)}
                        className={`w-full text-left px-3 py-1.5 rounded-lg text-[12px] transition-all duration-200 cursor-pointer ${
                          selectedVideo === v
                            ? "bg-blue-500/10 text-blue-700 ring-1 ring-blue-500/20 font-medium"
                            : "text-ink-muted hover:bg-black/[0.03]"
                        }`}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Thumbnail list */}
                <div>
                  <p className="text-[11px] font-medium text-ink-muted mb-2">
                    Ảnh thumbnail ({files.images.length})
                  </p>
                  <div className="max-h-[200px] overflow-y-auto space-y-1 rounded-xl bg-black/[0.015] p-2">
                    {files.images.map((img) => (
                      <button
                        key={img}
                        onClick={() => setSelectedThumb(img)}
                        className={`w-full text-left px-3 py-1.5 rounded-lg text-[12px] transition-all duration-200 cursor-pointer ${
                          selectedThumb === img
                            ? "bg-violet-500/10 text-violet-700 ring-1 ring-violet-500/20 font-medium"
                            : "text-ink-muted hover:bg-black/[0.03]"
                        }`}
                      >
                        {img}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {selectedThumb && files && (
              <div className="mt-3">
                <img
                  src={`/api/youtube/thumbnail/${files.path}/${selectedThumb}`}
                  alt="Thumbnail preview"
                  className="w-full max-w-[320px] rounded-xl ring-1 ring-black/[0.08]"
                />
              </div>
            )}

            {/* Custom thumbnail upload */}
            <div className="mt-3 flex items-center gap-3 flex-wrap">
              <label className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-violet-500/10 text-violet-700 ring-1 ring-violet-500/20 hover:bg-violet-500/20 transition-all duration-300 cursor-pointer">
                {customThumb ? customThumb.name : "Upload thumbnail"}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      setCustomThumb(f);
                      setCustomThumbPreview(URL.createObjectURL(f));
                      setSelectedThumb("");
                    }
                  }}
                />
              </label>
              {customThumb && (
                <>
                  <img src={customThumbPreview} alt="Custom thumb" className="h-12 rounded-lg ring-1 ring-black/[0.08]" />
                  <button
                    onClick={() => { setCustomThumb(null); setCustomThumbPreview(""); }}
                    className="text-[10px] text-red-500 hover:text-red-600 cursor-pointer"
                  >
                    Xoá
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </AnimatedBlock>

      {/* Step 2: Meta Input + Generate */}
      <AnimatedBlock delay={300}>
        <div className="double-bezel mb-6">
          <div className="double-bezel-inner p-5 sm:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-ink-muted mb-3">
              2. Nhập nội dung & tạo meta.json
            </p>
            <textarea
              value={rawInput}
              onChange={(e) => setRawInput(e.target.value)}
              placeholder="Dán toàn bộ nội dung video vào đây (tiêu đề, mô tả, tags, hashtags...). Gemini sẽ parse thành meta.json chuẩn."
              rows={6}
              className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2.5 text-[13px] text-ink resize-none focus:outline-none focus:ring-2 focus:ring-violet-500/20"
            />
            <div className="flex items-center gap-3 mt-3 flex-wrap">
              <button
                onClick={generateMeta}
                disabled={generating || !rawInput.trim()}
                className="btn-island-primary group text-sm !px-5 !py-2.5"
              >
                <IconSparkle className="w-3.5 h-3.5" />
                <span className="tracking-tight">
                  {generating ? "Đang tạo..." : "Tạo meta.json (Gemini)"}
                </span>
              </button>

              <select
                value={privacy}
                onChange={(e) => setPrivacy(e.target.value)}
                className="px-3 py-2 rounded-full text-[12px] font-medium bg-black/[0.02] ring-1 ring-black/[0.06] cursor-pointer"
              >
                <option value="private">Private</option>
                <option value="unlisted">Unlisted</option>
                <option value="public">Public</option>
              </select>
            </div>

            {genError && (
              <div className="mt-3 flex items-start gap-2 p-3 rounded-xl bg-red-500/8 ring-1 ring-red-500/15">
                <IconError className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                <p className="text-[12px] text-red-600/80 whitespace-pre-wrap">{genError}</p>
              </div>
            )}

            {meta && (
              <div className="mt-4 rounded-2xl bg-violet-500/[0.03] ring-1 ring-violet-500/[0.1] p-4">
                <div className="flex items-center gap-2 mb-3">
                  <IconCheck className="w-3.5 h-3.5 text-violet-500" />
                  <span className="text-[11px] font-medium text-violet-600/80 uppercase tracking-wider">
                    Meta Preview
                  </span>
                </div>
                <pre className="text-[11px] text-ink/80 font-mono whitespace-pre-wrap max-h-[300px] overflow-y-auto">
                  {JSON.stringify(meta, null, 2)}
                </pre>
                <div className="flex items-center gap-3 mt-3">
                  <button
                    onClick={saveMetaFile}
                    className="px-4 py-1.5 rounded-full text-[12px] font-medium bg-violet-500/10 text-violet-700 ring-1 ring-violet-500/20 hover:bg-violet-500/20 transition-all duration-300 active:scale-[0.97] cursor-pointer"
                  >
                    Lưu file meta.json
                  </button>
                  {savedMetaPath && (
                    <span className="text-[11px] text-emerald-600/80 font-mono">
                      ✓ {savedMetaPath}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </AnimatedBlock>

      {/* Step 3: Upload */}
      <AnimatedBlock delay={400}>
        <div className="double-bezel">
          <div className="double-bezel-inner p-5 sm:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-ink-muted mb-3">
              3. Upload lên YouTube
            </p>

            <div className="text-[12px] text-ink-muted space-y-1 mb-4">
              {selectedVideo && files && (
                <p>Video: <span className="font-mono text-ink/70">{files.path}/{selectedVideo}</span></p>
              )}
              {savedMetaPath && (
                <p>Meta: <span className="font-mono text-ink/70">{savedMetaPath}</span></p>
              )}
              {selectedThumb && files && (
                <p>Thumbnail: <span className="font-mono text-ink/70">{files.path}/{selectedThumb}</span></p>
              )}
            </div>

            <button
              onClick={handleUpload}
              disabled={uploading || !selectedVideo || !savedMetaPath || !config.has_client_secrets}
              title={!config.has_client_secrets ? "Cần cấu hình YouTube API trước" : ""}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-[13px] font-medium bg-red-600 text-white hover:bg-red-500 shadow-sm transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.97] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {uploading ? (
                <>
                  <IconSpinner className="w-4 h-4" />
                  Đang upload... {uploadProgress}%
                </>
              ) : (
                <>
                  <IconUpload className="w-4 h-4" />
                  Upload to YouTube
                </>
              )}
            </button>

            {uploading && (
              <div className="mt-3">
                <div className="h-1.5 rounded-full bg-black/[0.06] overflow-hidden max-w-md">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-red-600 to-red-400 transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)]"
                    style={{ width: `${Math.max(2, uploadProgress)}%` }}
                  />
                </div>
              </div>
            )}

            {!config.has_client_secrets && (
              <p className="mt-2 text-[11px] text-amber-600/80">
                ⚠️ Cần cấu hình YouTube API (client_secrets.json) trước khi upload.
              </p>
            )}

            {uploadResult && (
              <div className={`mt-3 p-3 rounded-xl text-[12px] whitespace-pre-wrap ${
                uploadResult.includes("thành công")
                  ? "bg-emerald-500/8 ring-1 ring-emerald-500/15 text-emerald-700"
                  : "bg-red-500/8 ring-1 ring-red-500/15 text-red-600/80"
              }`}>
                {uploadResult}
              </div>
            )}

            {/* Upload log — persists after done/error for inspection */}
            {uploadLines.length > 0 && (
              <div className="mt-3">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] font-medium uppercase tracking-[0.15em] text-ink-light">
                    Nhật ký upload
                  </span>
                  <span className="text-[10px] font-mono text-ink-light tabular-nums">
                    {uploadLines.length} dòng
                  </span>
                </div>
                <div className="max-h-[280px] overflow-y-auto rounded-xl bg-black/[0.02] ring-1 ring-black/[0.04] p-3">
                  {uploadLines.map((line, i) => (
                    <p key={i} className={`text-[10px] font-mono leading-snug whitespace-pre-wrap ${
                      line.includes("success") || line.includes("Upload successful")
                        ? "text-emerald-600/80"
                        : line.toLowerCase().includes("error") || line.toLowerCase().includes("fail")
                        ? "text-red-600/80"
                        : "text-ink-light"
                    }`}>{line}</p>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </AnimatedBlock>
    </main>
  );
}
