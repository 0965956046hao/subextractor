"use client";

import { useState, useRef, useCallback } from "react";
import { uploadVideo } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

interface Props {
  onUploaded: (videoId: string) => void;
}

const FORMATS = ["MP4", "MOV", "AVI", "MKV", "WebM"];

function UploadIcon({ dragging }: { dragging: boolean }) {
  return (
    <svg
      className={`w-10 h-10 sm:w-12 sm:h-12 transition-all duration-1000 ease-[cubic-bezier(0.32,0.72,0,1)] ${
        dragging ? "text-accent scale-110" : "text-ink-light"
      }`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

export default function UploadPage({ onUploaded }: Props) {
  const { t } = useI18n();
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("video/")) {
        setError(t("upload.selectVideo"));
        return;
      }
      setError("");
      setLoading(true);
      setProgress(0);
      setFileName(file.name);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const id = await uploadVideo(file, setProgress, ctrl.signal);
        onUploaded(id);
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "CanceledError") return;
        setError(t("upload.failed"));
      } finally {
        setLoading(false);
        abortRef.current = null;
      }
    },
    [onUploaded, t],
  );

  return (
    <div className="space-y-6">
      <div className="double-bezel">
        <div className="double-bezel-inner">
          <div
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files[0];
              if (f) handleFile(f);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onClick={loading ? undefined : () => inputRef.current?.click()}
            className={`relative min-h-[280px] sm:min-h-[320px] flex flex-col items-center justify-center px-8 py-12 sm:px-12 text-center transition-all duration-1000 ease-[cubic-bezier(0.32,0.72,0,1)]
              ${dragging ? "bg-accent/5" : ""}
              ${loading ? "cursor-default" : "cursor-pointer hover:bg-black/[0.01]"}`}
          >
            <input
              ref={inputRef}
              type="file"
              accept="video/*"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
              className="hidden"
            />

            {loading ? (
              <div className="flex flex-col items-center gap-5">
                <svg
                  className="w-8 h-8 text-accent animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    opacity="0.15"
                  />
                  <path
                    d="M12 2a10 10 0 019.95 9"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
                <div>
                  <p className="text-sm font-medium text-ink">{fileName}</p>
                  <p className="text-xs text-ink-muted mt-1.5">
                    {t("upload.uploading")}
                  </p>
                </div>
                <div className="w-full max-w-xs space-y-2">
                  <div className="h-1.5 rounded-full bg-black/[0.06] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-400 transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)]"
                      style={{ width: `${Math.max(progress, 2)}%` }}
                    />
                  </div>
                  <p className="text-xs font-mono text-ink-light text-center">
                    {progress}%
                  </p>
                </div>
                {error && (
                  <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-danger-muted ring-1 ring-danger/15 text-xs text-danger/80">
                    <svg
                      className="w-3.5 h-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    {error}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-5">
                <UploadIcon dragging={dragging} />
                <div>
                  <p className="text-base sm:text-lg font-medium text-ink/80">
                    {dragging ? t("upload.release") : t("upload.drop")}
                  </p>
                  <p className="text-sm text-ink-muted mt-1.5">
                    {t("upload.or")}{" "}
                    <span className="text-accent underline underline-offset-2 decoration-accent/30">
                      {t("upload.browseFiles")}
                    </span>{" "}
                    {t("upload.formatsHint")}
                  </p>
                </div>
                {error && (
                  <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-danger-muted ring-1 ring-danger/15 text-xs text-danger/80">
                    <svg
                      className="w-3.5 h-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    {error}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-ink-light mr-1">
          {t("upload.supported")}
        </span>
        {FORMATS.map((ext) => (
          <span key={ext} className="tag">
            {ext}
          </span>
        ))}
      </div>
    </div>
  );
}
