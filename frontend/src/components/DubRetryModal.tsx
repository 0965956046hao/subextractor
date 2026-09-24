"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { getFailedSegments, retryFailedSegments, rebuildFullAudio, reTranslateLine } from "@/lib/api";
import type { FailedSegment } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

function IconSpinner({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" opacity={0.15} />
      <path d="M12 2a10 10 0 019.95 9" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
    </svg>
  );
}

function secToLabel(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

interface DubRetryModalProps {
  videoId: string;
  initialFailed?: FailedSegment[];
  engine?: "capcut" | "google";
  sourceLang?: string;
  targetLang?: string;
  onClose: () => void;
  onContinue: () => void;
}

export default function DubRetryModal({ videoId, initialFailed, engine = "capcut", sourceLang = "zh", targetLang = "vi", onClose, onContinue }: DubRetryModalProps) {
  const { t } = useI18n();
  const [failed, setFailed] = useState<FailedSegment[]>(initialFailed || []);
  const [loading, setLoading] = useState(!initialFailed);
  const [retryingAll, setRetryingAll] = useState(false);
  const [retryingIndex, setRetryingIndex] = useState<number | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [editedTexts, setEditedTexts] = useState<Record<number, string>>({});
  const [retranslatingIndex, setRetranslatingIndex] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await getFailedSegments(videoId);
      setFailed(data.failed || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tải được danh sách lỗi");
    } finally {
      setLoading(false);
    }
  }, [videoId]);

  useEffect(() => {
    if (!initialFailed) refresh();
  }, [refresh, initialFailed]);

  const handleReTranslate = useCallback(async (idx: number) => {
    setRetranslatingIndex(idx);
    setError("");
    try {
      let newText = await reTranslateLine(videoId, idx, sourceLang, targetLang);
      // Safety strip "1|", "1." prefix if backend still returns it (old cache or Gemini quirks)
      newText = newText.replace(/^\d+\s*\|\s*/, "").replace(/^\d+[\.\)]\s+/, "").trim();
      setEditedTexts((prev) => ({ ...prev, [idx]: newText }));
      // Auto-open edit to show new translation
      setEditingIndex(idx);
      setEditText(newText);
    } catch (e) {
      setError(e instanceof Error ? e.message : `Dịch lại #${idx} thất bại`);
    } finally {
      setRetranslatingIndex(null);
    }
  }, [videoId, sourceLang, targetLang]);

  const handleRetryOne = useCallback(async (idx: number) => {
    setRetryingIndex(idx);
    setError("");
    try {
      const f = failed.find((x) => x.index === idx);
      const override = editedTexts[idx];
      const texts = override ? { [String(idx)]: override } : undefined;
      // If user is editing this line and hasn't saved yet, use editText
      const pendingEdit = editingIndex === idx && editText.trim() ? { [String(idx)]: editText.trim() } : texts;
      const res = await retryFailedSegments(videoId, { indices: [idx], engine, texts: pendingEdit });
      if (res.failed.length > 0) {
        const msg = res.failed.map((f) => `#${f.index}: ${f.error}`).join(" | ");
        setError(`Thử lại #${idx} vẫn lỗi: ${msg}. Gợi ý: nội dung "${f?.text.slice(0, 30)}" có thể là rác OCR — hãy sửa thành tiếng Việt có nghĩa rồi thử lại.`);
      } else {
        // success: clear edit state for this index
        setEditedTexts((prev) => {
          const n = { ...prev };
          delete n[idx];
          return n;
        });
        setEditingIndex(null);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : `Thử lại #${idx} thất bại`);
    } finally {
      setRetryingIndex(null);
    }
  }, [videoId, engine, refresh, failed, editedTexts, editingIndex, editText]);

  const handleRetryAll = useCallback(async () => {
    if (failed.length === 0) return;
    setRetryingAll(true);
    setError("");
    try {
      const texts = Object.keys(editedTexts).length > 0 ? Object.fromEntries(Object.entries(editedTexts).map(([k, v]) => [k, v])) : undefined;
      const res = await retryFailedSegments(videoId, { engine, texts });
      if (res.failed.length > 0) {
        setError(`${res.failed.length} dòng vẫn lỗi sau retry. Nhiều dòng lỗi là rác OCR (ví dụ "倅交：辛坚") — CapCut không đọc được, hãy Sửa từng dòng thành tiếng Việt có nghĩa.`);
      }
      await refresh();
      // If at least some succeeded, rebuild full_audio silently
      if (res.succeeded > 0) {
        setRebuilding(true);
        try {
          await rebuildFullAudio(videoId);
        } catch {
          /* ignore rebuild error, user can trigger manually */
        } finally {
          setRebuilding(false);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Thử lại tất cả thất bại");
    } finally {
      setRetryingAll(false);
    }
  }, [videoId, engine, failed.length, refresh, editedTexts]);

  const handleRebuildAndContinue = useCallback(async () => {
    setRebuilding(true);
    setError("");
    try {
      await rebuildFullAudio(videoId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Tạo lại audio thất bại";
      // Timeout or server busy — still allow pipeline to continue to hardcode.
      // Hardcode doesn't require full_audio; dub audio can be rebuilt in background.
      if (msg.includes("timeout") || msg.includes("exceeded")) {
        setError(`Rebuild hơi lâu (${msg}) — vẫn tiếp tục sang hardcode, audio sẽ tự xong nền.`);
      } else {
        setError(msg);
      }
      setRebuilding(false);
      // Still continue; don't block pipeline on dub rebuild
      onContinue();
      return;
    }
    setRebuilding(false);
    onContinue();
  }, [videoId, onContinue]);

  if (!mounted) return null;

  const hasFailed = failed.length > 0;

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 backdrop-blur-sm p-3 sm:p-6">
      <div className="double-bezel w-[92vw] max-w-[560px] max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()} style={{ animation: "scale-in 0.32s cubic-bezier(0.32,0.72,0,1) forwards" }}>
        <div className="double-bezel-inner p-4 sm:p-5 flex flex-col gap-4 min-h-0">
          {/* Header */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-full bg-amber-500/15 flex items-center justify-center">
                <svg className="w-5 h-5 text-amber-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-ink">Dub thất bại một số dòng</p>
                <p className="text-[11px] text-ink-muted">
                  {loading ? "Đang kiểm tra..." : hasFailed ? `${failed.length} dòng bị chèn khoảng lặng — bạn có thể thử lại từng dòng` : "Tất cả dòng đã có audio — có thể tiếp tục"}
                </p>
              </div>
            </div>
            <button onClick={onClose} className="icon-btn flex-shrink-0">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
            </button>
          </div>

          {error && (
            <div className="rounded-xl bg-danger-muted ring-1 ring-danger/15 px-3 py-2 text-[12px] text-danger">{error}</div>
          )}

          {/* Failed list */}
          <div className="flex-1 min-h-0 overflow-y-auto rounded-xl bg-white/[0.03] ring-1 ring-white/[0.08] divide-y divide-black/[0.04]">
            {loading && (
              <div className="flex items-center justify-center gap-2 p-6 text-[12px] text-ink-muted"><IconSpinner /> Đang tải danh sách lỗi...</div>
            )}
            {!loading && failed.map((f) => {
              const isEditing = editingIndex === f.index;
              const displayText = editedTexts[f.index] ?? f.text;
              const isNoisy = /[\u4e00-\u9fff]{2,}/.test(f.text) && /[倅伯份上]/.test(f.text);
              return (
              <div key={f.index} className="px-3 py-2.5 flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 flex-shrink-0">#{f.index}</span>
                  <span className="font-mono text-[10px] text-ink-light flex-shrink-0">{secToLabel(f.start)} → {secToLabel(f.end)}</span>
                  {f.voice_type && <span className="text-[10px] text-ink-muted truncate ml-auto">{f.voice_type}</span>}
                  <button
                    onClick={() => {
                      if (isEditing) {
                        if (editText.trim() && editText.trim() !== f.text) {
                          setEditedTexts((prev) => ({ ...prev, [f.index]: editText.trim() }));
                        }
                        setEditingIndex(null);
                      } else {
                        setEditingIndex(f.index);
                        setEditText(editedTexts[f.index] ?? f.text);
                      }
                    }}
                    className="w-6 h-6 rounded-full flex items-center justify-center bg-white/10 hover:bg-white/15 text-ink-muted cursor-pointer flex-shrink-0"
                    title={isEditing ? "Đóng sửa" : "Sửa nội dung"}
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
                  </button>
                  <button
                    onClick={() => handleReTranslate(f.index)}
                    disabled={retranslatingIndex === f.index || retryingAll}
                    className="w-6 h-6 rounded-full flex items-center justify-center bg-violet-500/15 hover:bg-violet-500/25 text-violet-300 cursor-pointer flex-shrink-0 disabled:opacity-50"
                    title="Dịch lại bằng Gemini (từ gốc OCR)"
                  >
                    {retranslatingIndex === f.index ? <IconSpinner className="w-3 h-3" /> : (
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M3 8v4h4" /><path d="M21 16v4h-4" /></svg>
                    )}
                  </button>
                  <button
                    onClick={() => handleRetryOne(f.index)}
                    disabled={retryingIndex === f.index || retryingAll || retranslatingIndex === f.index}
                    className="text-[11px] font-medium px-2.5 py-1 rounded-full bg-accent text-white hover:bg-accent/90 transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1 flex-shrink-0"
                  >
                    {retryingIndex === f.index ? <IconSpinner className="w-3 h-3" /> : (
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 11-6.219-8.56" /><path d="M21 3v6h-6" /></svg>
                    )}
                    Thử lại
                  </button>
                </div>
                {isNoisy && (
                  <span className="text-[10px] text-amber-600 bg-amber-500/10 px-1.5 py-0.5 rounded w-fit">⚠ Dòng rác OCR — nên sửa thành tiếng Việt hoặc bỏ qua</span>
                )}
                {isEditing ? (
                  <div className="flex flex-col gap-1.5">
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={2}
                      className="w-full text-[12px] leading-snug p-2 rounded-lg bg-white ring-1 ring-violet-300 text-gray-900 placeholder:text-gray-400 caret-violet-600 selection:bg-violet-200 selection:text-gray-900 resize-none focus:outline-none focus:ring-2 focus:ring-violet-500"
                      autoFocus
                    />
                    {f.original_text && f.original_text !== f.text && (
                      <p className="text-[10px] text-ink-light">Gốc OCR: <span className="text-ink-muted">{f.original_text}</span></p>
                    )}
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => {
                          if (editText.trim()) setEditedTexts((prev) => ({ ...prev, [f.index]: editText.trim() }));
                          setEditingIndex(null);
                        }}
                        className="text-[10px] font-medium px-2.5 py-1 rounded-md bg-violet-600 text-white hover:bg-violet-700 cursor-pointer"
                      >
                        Lưu
                      </button>
                      <button onClick={() => setEditingIndex(null)} className="text-[10px] px-2.5 py-1 rounded-md bg-white/10 text-ink-muted hover:bg-white/15 cursor-pointer">Hủy</button>
                      <button
                        onClick={() => handleRetryOne(f.index)}
                        disabled={retryingIndex === f.index}
                        className="ml-auto text-[10px] font-medium px-2.5 py-1 rounded-md bg-accent text-white hover:bg-accent/90 cursor-pointer disabled:opacity-50 inline-flex items-center gap-1"
                      >
                        {retryingIndex === f.index ? <IconSpinner className="w-3 h-3" /> : null}
                        Lưu & Thử lại
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-[12px] leading-snug text-ink">{editedTexts[f.index] ? <><span className="text-ink line-through decoration-amber-500/50">{f.text}</span> <span className="text-success">→ {editedTexts[f.index]}</span></> : displayText}</p>
                    {f.original_text && f.original_text !== f.text && (
                      <p className="text-[10px] text-ink-light font-mono truncate">Gốc: {f.original_text}</p>
                    )}
                  </>
                )}
              </div>
              );
            })}
            {!loading && !hasFailed && (
              <div className="p-6 text-center">
                <p className="text-[12px] font-medium text-success">✓ Không còn dòng lỗi — audio đã đầy đủ.</p>
                <p className="text-[11px] text-ink-muted mt-1">Bạn có thể nhấn Tiếp tục để sang bước hardcode.</p>
              </div>
            )}
          </div>

           {/* Footer actions */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={onClose} className="btn-island-secondary btn-sm">Đóng</button>
              <div className="flex-1" />
              {hasFailed && (
                <button
                  onClick={handleRetryAll}
                  disabled={retryingAll || rebuilding}
                  className="px-4 py-2 rounded-full text-[12px] font-medium bg-amber-500 text-white hover:bg-amber-600 transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {retryingAll ? <IconSpinner className="w-3.5 h-3.5" /> : (
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 11-6.219-8.56" /><path d="M21 3v6h-6" /></svg>
                  )}
                  {retryingAll ? "Đang thử lại..." : `Thử lại tất cả (${failed.length})`}
                </button>
              )}
              <button
                onClick={async () => {
                  if (hasFailed) {
                    // Rebuild full_audio from already-fixed lines before continuing
                    setRebuilding(true);
                    setError("");
                    try { await rebuildFullAudio(videoId); } catch (e) {
                      setError(e instanceof Error ? e.message : "Tạo lại audio thất bại — vẫn tiếp tục pipeline");
                    } finally { setRebuilding(false); }
                    onContinue();
                  } else {
                    handleRebuildAndContinue();
                  }
                }}
                disabled={retryingAll || rebuilding}
                className="px-4 py-2 rounded-full text-[12px] font-medium bg-violet-600 text-white hover:bg-violet-500 transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
                title={hasFailed ? "Tạo lại full_audio từ các dòng đã sửa rồi tiếp tục sang hardcode" : "Tạo lại full_audio và tiếp tục sang hardcode"}
              >
                {rebuilding ? <IconSpinner className="w-3.5 h-3.5" /> : (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
                )}
                {hasFailed ? `Tiếp tục pipeline ${failed.length ? `(${failed.length} dòng sẽ giữ im lặng)` : ""}` : rebuilding ? "Đang tạo lại..." : "Tiếp tục sang hardcode →"}
              </button>
            </div>
            {!hasFailed && (
              <div className="rounded-lg bg-success/10 ring-1 ring-success/20 px-3 py-2 text-[11px] text-success leading-relaxed flex items-center gap-2">
                <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M20 6L9 17l-5-5" /></svg>
                Đã sửa xong — bấm <b>Tiếp tục sang hardcode</b> để pipeline nhúng phụ đề và tạo video cuối. Nút này sẽ tự <b>xây lại full_audio</b> rồi chạy bước kế tiếp.
              </div>
            )}
            <p className="text-[10px] text-ink-light leading-relaxed">
              {hasFailed
                ? <>Luồng: <span className="text-violet-300">Sửa text</span> (bút chì / Dịch lại) → <span className="text-accent">Thử lại</span> từng dòng → khi list trống hoặc muốn bỏ qua, bấm <b>Tiếp tục pipeline</b>. Nút này sẽ <b>tự rebuild audio</b> rồi sang hardcode — không cần đóng popup rồi làm gì thêm.</>
                : <>Mẹo: Dòng rác OCR (ví dụ "倅交：辛坚") chưa được dịch nên CapCut không đọc được — bấm <span className="text-violet-600 font-medium">Dịch lại</span> để Gemini dịch lại từ gốc, hoặc bút chì để sửa tay, rồi <span className="text-accent font-medium">Thử lại</span>.</>
              }
            </p>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
