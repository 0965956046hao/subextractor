"use client";

import { useEffect, useState } from "react";
import {
  OwnedVideoItem,
  formatDate,
  formatViews,
  getOwnedVideos,
  lowThumbnailUrl,
  parseDuration,
} from "@/lib/api";
import { startVideoDownload } from "@/lib/downloads";
import { DownloadIcon } from "@/components/icons";

type CookieBrowser = "chrome" | "firefox" | "safari" | "edge" | "brave";

function restrictionLabels(video: OwnedVideoItem): string[] {
  const labels: string[] = [];
  if (video.upload_status && video.upload_status !== "processed") {
    labels.push(`Upload: ${video.upload_status}`);
  }
  if (video.rejection_reason) labels.push(`Bị từ chối: ${video.rejection_reason}`);
  if (video.failure_reason) labels.push(`Lỗi: ${video.failure_reason}`);
  if (video.region_blocked.length > 0) labels.push(`Chặn tại ${video.region_blocked.length} khu vực`);
  if (video.region_allowed.length > 0) labels.push(`Chỉ mở tại ${video.region_allowed.length} khu vực`);
  if (video.age_restricted) labels.push("Giới hạn tuổi");
  return labels;
}

export default function RestrictedVideos({
  connected,
  onSelect,
  onOpenConfig,
}: {
  connected: boolean;
  onSelect: (video: OwnedVideoItem) => void;
  onOpenConfig: () => void;
}) {
  const [videos, setVideos] = useState<OwnedVideoItem[]>([]);
  const [browser, setBrowser] = useState<CookieBrowser>("chrome");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const result = await getOwnedVideos(500);
      setVideos(result.videos);
    } catch (e) {
      setVideos([]);
      setError(e instanceof Error ? e.message : "Không lấy được video của kênh.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (connected) load();
  }, [connected]);

  const visible = videos.filter((video) =>
    video.upload_status === "rejected" ||
    Boolean(video.rejection_reason) ||
    video.region_blocked.length > 0 ||
    video.region_allowed.length > 0
  );

  if (!connected) {
    return (
      <div className="double-bezel animate-fade-up">
        <div className="double-bezel-inner p-7">
          <span className="eyebrow">Video của chính kênh</span>
          <h2 className="mt-3 text-xl font-semibold">Cần kết nối tài khoản chủ kênh</h2>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-ink-muted">
            Kết nối OAuth để kiểm tra video bị chặn, bị từ chối hoặc giới hạn khu vực của kênh.
          </p>
          <button className="btn-island-primary btn-sm mt-4" onClick={onOpenConfig}>Mở Cấu hình</button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-up">
      <div className="double-bezel">
        <div className="double-bezel-inner p-5">
          <div className="flex flex-wrap items-start gap-4">
            <div className="min-w-0 flex-1">
              <span className="eyebrow">Uploads của tài khoản OAuth</span>
              <h2 className="mt-2 text-xl font-semibold">Video bị chặn</h2>
              <p className="mt-1.5 max-w-3xl text-[12px] leading-relaxed text-ink-muted">
                Chỉ hiển thị video bị từ chối hoặc bị chặn theo khu vực. Chi tiết claim Content ID đầy đủ vẫn cần kiểm tra trong YouTube Studio.
              </p>
            </div>
            <button className="btn-island-primary btn-sm" disabled={loading} onClick={load}>
              {loading ? "Đang tải…" : "Tải lại"}
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-white/10 pt-4">
            <span className="tag chip-active !px-3 !py-2">Bị chặn · {visible.length}</span>
            <label className="ml-auto block min-w-44">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-ink-light">
                Trình duyệt đã login YouTube
              </span>
              <select className="input-field !py-2" value={browser} onChange={(e) => setBrowser(e.target.value as CookieBrowser)}>
                <option value="chrome">Google Chrome</option>
                <option value="firefox">Firefox</option>
                <option value="safari">Safari</option>
                <option value="edge">Microsoft Edge</option>
                <option value="brave">Brave</option>
              </select>
            </label>
          </div>
          {message && <p className="mt-3 text-[12px] text-accent-light">{message}</p>}
          {error && <p className="mt-3 text-[12px] text-red-300">{error}</p>}
        </div>
      </div>

      {!loading && !error && visible.length === 0 && (
        <div className="double-bezel">
          <div className="double-bezel-inner p-8 text-center text-[13px] text-ink-muted">
            Data API chưa phát hiện video bị chặn trong danh sách đã tải.
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {visible.map((video) => {
          const labels = restrictionLabels(video);
          return (
            <article key={video.video_id} className="double-bezel">
              <div className="double-bezel-inner h-full overflow-hidden">
                <button className="block w-full text-left" onClick={() => onSelect(video)}>
                  <div className="relative aspect-video bg-black/40">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={lowThumbnailUrl(video.video_id)}
                      alt={video.title}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                    {video.duration && (
                      <span className="absolute bottom-2 right-2 rounded bg-black/80 px-1.5 py-0.5 text-[11px]">
                        {parseDuration(video.duration)}
                      </span>
                    )}
                  </div>
                  <div className="p-3.5 pb-2">
                    <p className="line-clamp-2 text-[13px] font-semibold leading-snug">{video.title || video.video_id}</p>
                    <p className="mt-1 text-[11px] text-ink-light">
                      {formatDate(video.published_at)} · {formatViews(video.view_count)} lượt xem
                    </p>
                    <div className="mt-2 flex min-h-6 flex-wrap gap-1">
                      {(labels.length > 0 ? labels : ["API chưa báo hạn chế"]).map((label) => (
                        <span key={label} className={`tag !text-[10px] ${labels.length > 0 ? "!border-amber-300/30 !text-amber-200" : ""}`}>
                          {label}
                        </span>
                      ))}
                    </div>
                  </div>
                </button>
                <div className="flex gap-2 px-3.5 pb-3.5">
                  <button
                    className="btn-island-secondary btn-xs flex-1"
                    onClick={() => {
                      startVideoDownload(video.video_id, "best", browser)
                        .then(() => setMessage(`Đã tạo tác vụ tải “${video.title || video.video_id}” bằng cookie ${browser}.`))
                        .catch((e) => setMessage(e instanceof Error ? e.message : "Không tạo được tác vụ tải."));
                    }}
                  >
                    <DownloadIcon className="h-3 w-3" /> Tải có đăng nhập
                  </button>
                  <a
                    className="btn-island-secondary btn-xs"
                    href={`https://studio.youtube.com/video/${video.video_id}/edit`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Studio ↗
                  </a>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
