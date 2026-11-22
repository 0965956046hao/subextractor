export type OcrDecoder = "nvdec" | "ffmpeg_cpu";

export const OCR_DECODERS: OcrDecoder[] = ["nvdec", "ffmpeg_cpu"];

// Migrate missing/retired values to CPU FFmpeg; new videos explicitly use NVDEC.
export function savedOcrDecoder(value: unknown): OcrDecoder {
  return value === "nvdec" ? value : "ffmpeg_cpu";
}
