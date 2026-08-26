"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { Lightbox } from "react-modal-image";

type PreviewModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  thumbnail?: string | null;
  videoUrl?: string | null;
  audioUrl?: string | null;
  bigThumbs?: string[];
};

export default function PreviewModal({
  open,
  onClose,
  title,
  thumbnail,
  videoUrl,
  audioUrl,
  bigThumbs,
}: PreviewModalProps) {
  const [zoomSrc, setZoomSrc] = useState<string | null>(null);

  if (!open) return null;

  return (
    <>
      {createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/40 backdrop-blur-sm p-4"
          onClick={onClose}
        >
          <div
            className="double-bezel w-full max-w-3xl my-auto"
            onClick={(e) => e.stopPropagation()}
            style={{
              animation:
                "scale-in 0.35s cubic-bezier(0.32,0.72,0,1) forwards",
            }}
          >
            <div className="double-bezel-inner p-5 sm:p-6">
              <div className="flex items-center justify-between gap-3 mb-4">
                <p className="text-sm font-semibold text-ink truncate">
                  {title}
                </p>
                <button
                  onClick={onClose}
                  className="w-8 h-8 rounded-lg bg-white/[0.05] text-ink-muted flex items-center justify-center hover:bg-white/[0.11] hover:text-ink transition-colors cursor-pointer flex-shrink-0"
                >
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>

              <div className="grid gap-4 md:grid-cols-2 items-stretch">
                <div className="flex flex-col">
                  <p className="text-[11px] font-medium text-ink-muted mb-2">
                    Thumbnail
                  </p>
                  <div className="flex-1 rounded-xl overflow-hidden bg-black ring-1 ring-white/[0.09] min-h-[200px]">
                    {thumbnail ? (
                      <img
                        src={thumbnail}
                        alt={title}
                        className="w-full h-full object-cover cursor-zoom-in"
                        onClick={() => setZoomSrc(thumbnail)}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-ink-light">
                        No thumbnail
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex flex-col space-y-4">
                  <div className="flex-1 flex flex-col">
                    <p className="text-[11px] font-medium text-ink-muted mb-2">
                      Video
                    </p>
                    <div className="flex-1 rounded-xl overflow-hidden bg-black ring-1 ring-white/[0.09] min-h-[200px]">
                      {videoUrl ? (
                        // eslint-disable-next-line jsx-a11y/media-has-caption
                        <video
                          src={videoUrl}
                          controls
                          className="w-full h-full object-contain"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-ink-light">
                          No video
                        </div>
                      )}
                    </div>
                  </div>
                  {audioUrl && (
                    <div className="flex-1 flex flex-col">
                      <p className="text-[11px] font-medium text-ink-muted mb-2">
                        Audio
                      </p>
                      <div className="flex-1 rounded-xl overflow-hidden bg-black ring-1 ring-white/[0.09] min-h-[120px]">
                        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                        <video
                          src={audioUrl}
                          controls
                          className="w-full h-full object-contain"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {bigThumbs && bigThumbs.length > 0 && (
                <div className="mt-4">
                  <p className="text-[11px] font-medium text-ink-muted mb-2">
                    Big Thumbnails
                  </p>
                  <div className="grid gap-3 grid-cols-2 sm:grid-cols-3">
                    {bigThumbs.map((src, i) => (
                      <div
                        key={i}
                        className="rounded-xl overflow-hidden bg-black ring-1 ring-white/[0.09] aspect-video cursor-zoom-in"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={src}
                          alt=""
                          className="w-full h-full object-cover"
                          onClick={() => setZoomSrc(src)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {zoomSrc &&
        createPortal(
          <Lightbox
            medium={zoomSrc}
            large={zoomSrc}
            alt={title}
            onClose={() => setZoomSrc(null)}
            hideDownload
          />,
          document.body,
        )}
    </>
  );
}
