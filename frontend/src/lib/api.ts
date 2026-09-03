import axios from "axios";

const api = axios.create({
  baseURL: "/api",
  timeout: 30000,
});

api.interceptors.response.use(
  (res) => res,
  (error) => {
    if (axios.isCancel(error)) return Promise.reject(error);
    const msg =
      error.response?.data?.detail ||
      error.message ||
      "An unexpected error occurred";
    return Promise.reject(new Error(msg));
  },
);

export async function uploadVideo(
  file: File,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const res = await api.post<{ video_id: string }>("/upload", form, {
    headers: { "Content-Type": "multipart/form-data" },
    // File video lớn có thể mất hàng chục phút để upload → timeout 120 phút.
    timeout: 120 * 60 * 1000,
    onUploadProgress: (e) => {
      if (onProgress && e.total)
        onProgress(Math.round((e.loaded * 100) / e.total));
    },
    signal,
  });
  return res.data.video_id;
}

export function getVideoUrl(videoId: string): string {
  return `/api/video/${videoId}`;
}

export function getFrameUrl(videoId: string): string {
  return `/api/frame/${videoId}`;
}

export type VideoStatus =
  | "uploaded"
  | "queued"
  | "processing"
  | "done"
  | "error"
  | "cancelled";

export interface PipelineTimelineCheck {
  waiting: boolean;
  open: boolean;
  issues: TimelineIssue[];
  fixing: boolean;
  decision?: string | null;
}

export interface PipelineProgress {
  status: string;
  stage: string;
  progress: number;
  step_progress: (number | null)[];
  error?: string;
  timeline_check?: PipelineTimelineCheck | null;
  voice_check?: { waiting?: boolean; decision?: string | null } | null;
}

export interface VideoMeta {
  video_id: string;
  filename: string;
  has_video: boolean;
  has_dubbed?: boolean;
  entries: number;
  created_at: string;
  status?: VideoStatus;
  progress?: number;
  phase?: string;
  job_type?: string;
  origin?: "extract" | "pipeline";
  job_id?: string;
  error?: string | null;
  logs?: LogEntry[];
  pipeline?: PipelineProgress;
}

export interface ContextImages {
  thumbnail: string | null;
  images: string[];
}

export async function getContextImages(
  videoId: string,
): Promise<ContextImages> {
  const res = await api.get(`/context-images/${videoId}`);
  return res.data;
}

export async function listVideos(): Promise<VideoMeta[]> {
  const res = await api.get<{ videos: VideoMeta[] }>("/videos");
  return res.data.videos;
}

export async function reportPipelineState(
  videoId: string,
  state: PipelineProgress,
): Promise<void> {
  await api.post(`/pipeline/${videoId}`, state);
}

export async function getPipelineState(
  videoId: string,
): Promise<PipelineProgress> {
  const res = await api.get<PipelineProgress>(`/pipeline/${videoId}`);
  return res.data;
}

export async function reportTimelineAction(
  videoId: string,
  action: "wait" | "open" | "close" | "continue" | "fix",
  issues: TimelineIssue[] = [],
): Promise<void> {
  await api.post(`/pipeline/${videoId}/timeline`, { action, issues });
}

export async function deleteVideo(videoId: string): Promise<void> {
  await api.delete(`/video/${videoId}`);
}

export interface Region {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface LogEntry {
  message: string;
  ts: number;
  level: string;
}

export interface JobStatus {
  job_id: string;
  status: string;
  phase: string;
  progress: number;
  error: string | null;
  logs?: LogEntry[];
}

export type OcrLang = "ch" | "en" | "latin";

export const OCR_LANGS: { value: OcrLang; label: string; hint: string }[] = [
  { value: "ch", label: "lang.zh", hint: "ocr.ch.hint" },
  { value: "latin", label: "lang.vi", hint: "ocr.latin.hint" },
  { value: "en", label: "lang.en", hint: "ocr.en.hint" },
];

export type OcrType = "rapid" | "apple";

export const OCR_TYPES: { value: OcrType; label: string; hint: string }[] = [
  { value: "apple", label: "ocr.type.apple", hint: "ocr.type.apple.hint" },
  { value: "rapid", label: "ocr.type.rapid", hint: "ocr.type.rapid.hint" },
];

export async function startProcess(
  videoId: string,
  region: Region,
  lang: OcrLang = "ch",
  ocrType: OcrType = "apple",
  signal?: AbortSignal,
  startTime?: number | null,
  endTime?: number | null,
): Promise<JobStatus> {
  const res = await api.post<JobStatus>(
    "/process",
    {
      video_id: videoId,
      region,
      lang,
      ocr_type: ocrType,
      ...(startTime != null && startTime > 0 ? { start_time: startTime } : {}),
      ...(endTime != null && endTime > 0 ? { end_time: endTime } : {}),
    },
    { signal },
  );
  return res.data;
}

export async function getJobStatus(jobId: string): Promise<JobStatus> {
  const res = await api.get<JobStatus>(`/status/${jobId}`);
  return res.data;
}

export async function cancelJob(jobId: string): Promise<void> {
  await api.post(`/process/${jobId}/cancel`);
}

export function createWsUrl(jobId: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/ws/${jobId}`;
}

export function getDownloadUrl(
  videoId: string,
  format: "srt" | "txt" = "srt",
): string {
  return `/api/download/${videoId}?format=${format}`;
}

export async function getSrtContent(videoId: string): Promise<string> {
  const res = await api.get<{ content: string }>(`/srt/${videoId}`);
  return res.data.content;
}

export interface SrtEntry {
  index: number;
  start: number;
  end: number;
  startLabel: string;
  endLabel: string;
  text: string;
}

export async function getSrtEntries(videoId: string): Promise<SrtEntry[]> {
  const res = await api.get<{ entries: SrtEntry[] }>(`/srt/${videoId}/entries`);
  return res.data.entries;
}

export async function updateSrt(
  videoId: string,
  content: string,
): Promise<void> {
  await api.put(`/srt/${videoId}`, { content });
}

export async function reTranslateLine(
  videoId: string,
  index: number,
  sourceLang: string,
  targetLang: string,
): Promise<string> {
  const res = await api.post<{ text: string }>(
    `/srt/${videoId}/re-translate-line`,
    {
      index,
      source_lang: sourceLang,
      target_lang: targetLang,
    },
  );
  return res.data.text;
}

export interface TimelineIssue {
  index: number;
  type: "negative_duration" | "overlap" | "out_of_order";
  message: string;
  start: number;
  end: number;
  prev_index?: number;
}

export interface TimelineFix {
  index: number;
  type: "negative_duration" | "overlap";
  from: string;
  to: string;
}

export async function validateSrtTimeline(
  videoId: string,
): Promise<{ issues: TimelineIssue[]; count: number }> {
  const res = await api.get<{ issues: TimelineIssue[]; count: number }>(
    `/srt/${videoId}/validate`,
  );
  return res.data;
}

export async function fixSrtTimeline(
  videoId: string,
): Promise<{ entries: SrtEntry[]; fixes: TimelineFix[]; count: number }> {
  const res = await api.post<{
    entries: SrtEntry[];
    fixes: TimelineFix[];
    count: number;
  }>(`/srt/${videoId}/fix-timeline`);
  return res.data;
}

export interface SubtitleRisk {
  index: number;
  text: string;
  problems: string[];
  note: string;
}

export type SubtitleRiskProblem =
  | "NOT_TRANSLATED"
  | "TIMELINE_OVERLAP"
  | "ADJACENT_SIMILAR";

export async function startSrtRiskCheck(
  videoId: string,
  lang = "vi",
): Promise<{ job_id: string }> {
  const res = await api.post<{ job_id: string }>(`/srt/${videoId}/risk-check`, {
    lang,
  });
  return res.data;
}

export async function getSrtRiskResult(
  videoId: string,
): Promise<{ risks: SubtitleRisk[]; checked_at?: number | null }> {
  const res = await api.get<{
    risks: SubtitleRisk[];
    checked_at?: number | null;
  }>(`/srt/${videoId}/risk-check`);
  return res.data;
}

export async function muxSubtitles(videoId: string): Promise<JobStatus> {
  const res = await api.post<JobStatus>(`/mux/${videoId}`);
  return res.data;
}

export function getMuxedDownloadUrl(videoId: string): string {
  return `/api/download/muxed/${videoId}`;
}

export async function hardcodeSubtitles(videoId: string): Promise<JobStatus> {
  const res = await api.post<JobStatus>(`/hardcode/${videoId}`);
  return res.data;
}

export async function delogoVideo(
  videoId: string,
  region: Region,
): Promise<{ status: string; path: string }> {
  const res = await api.post<{ status: string; path: string }>(
    `/delogo/${videoId}`,
    { region },
  );
  return res.data;
}

export function getHardcodedDownloadUrl(videoId: string): string {
  return `/api/download/hardcoded/${videoId}`;
}

export async function alignSubtitles(videoId: string): Promise<JobStatus> {
  const res = await api.post<JobStatus>(`/align/${videoId}`);
  return res.data;
}

export async function translateSubtitles(videoId: string): Promise<JobStatus> {
  const res = await api.post<JobStatus>(`/translate/${videoId}`);
  return res.data;
}

export function getTranslatedDownloadUrl(videoId: string): string {
  return `/api/download/translated/${videoId}`;
}

export async function ttsSubtitles(videoId: string): Promise<JobStatus> {
  const res = await api.post<JobStatus>(`/tts/${videoId}`);
  return res.data;
}

export function getDubbedDownloadUrl(videoId: string): string {
  return `/api/download/dubbed/${videoId}`;
}

export function getDubbedVoiceDownloadUrl(videoId: string): string {
  return `/api/tts-audio/${videoId}/full_voice.mp3`;
}

export interface HealthCheckResult {
  service: string;
  configured: boolean;
  healthy: boolean;
  message: string;
}

export interface PipelineHealth {
  healthy: boolean;
  checks: HealthCheckResult[];
  dub_engines?: { google: boolean; capcut: boolean };
}

export async function getPipelineHealth(): Promise<PipelineHealth> {
  const res = await api.get<PipelineHealth>("/health/checks");
  return res.data;
}

export interface ProfileCheck {
  exists: boolean;
  path: string;
}

export interface ProfilesCheck {
  douyin: ProfileCheck;
  chatgpt: ProfileCheck;
}

export async function getProfilesCheck(): Promise<ProfilesCheck> {
  const res = await api.get<ProfilesCheck>("/profiles/check");
  return res.data;
}

export interface ProfileConfig {
  douyin?: string;
  chatgpt?: string;
}

export interface ProfilesConfigResponse {
  config: ProfileConfig;
  resolved: {
    douyin: ProfileCheck;
    chatgpt: ProfileCheck;
  };
}

export async function getProfilesConfig(): Promise<ProfilesConfigResponse> {
  const res = await api.get<ProfilesConfigResponse>("/profiles/config");
  return res.data;
}

export async function saveProfilesConfig(
  cfg: ProfileConfig,
): Promise<{ status: string; config: ProfileConfig }> {
  const res = await api.post<{ status: string; config: ProfileConfig }>(
    "/profiles/config",
    cfg,
  );
  return res.data;
}

export async function douyinLogin(): Promise<{ status: string; mode: string }> {
  const res = await api.post<{ status: string; mode: string }>(
    "/video-download/login",
  );
  return res.data;
}

export async function chatgptLogin(): Promise<{
  status: string;
  mode: string;
}> {
  const res = await api.post<{ status: string; mode: string }>(
    "/chatgpt/login",
  );
  return res.data;
}

export interface CapCutVoice {
  voice_type: string;
  display_name: string;
  resource_id: string;
  lang: string;
  lan: string;
}

export async function getCapCutVoices(lang = "vi-VN"): Promise<CapCutVoice[]> {
  const res = await api.get<CapCutVoice[]>("/capcut/voices", {
    params: { lang },
  });
  return res.data;
}

export interface VoiceMapLine {
  voice_type: string;
  display_name: string;
}

export interface VoiceMapDetail {
  exists: boolean;
  voices: number;
  lang: string;
  map: Record<string, VoiceMapLine>;
}

export async function getVoiceMapDetail(
  videoId: string,
  lang = "vi",
): Promise<VoiceMapDetail> {
  const res = await api.get<VoiceMapDetail>(`/voice-map/${videoId}`, {
    params: { lang },
  });
  return res.data;
}

export async function generateVoiceMap(
  videoId: string,
  lang = "vi",
): Promise<{ status: string; voices: number }> {
  const res = await api.post<{ status: string; voices: number }>(
    `/voice-map/${videoId}`,
    { target_lang: lang },
  );
  return res.data;
}

export async function updateVoiceMapLine(
  videoId: string,
  index: number,
  voiceType: string,
): Promise<{ status: string; index: number; voice_type: string }> {
  const res = await api.patch<{
    status: string;
    index: number;
    voice_type: string;
  }>(`/voice-map/${videoId}/line`, { index, voice_type: voiceType });
  return res.data;
}

export async function bulkSwitchVoice(
  videoId: string,
  fromVoice: string,
  toVoice: string,
): Promise<{ job_id: string; status: string }> {
  const res = await api.post<{ job_id: string; status: string }>(
    `/voice-map/${videoId}/bulk-switch`,
    { from_voice: fromVoice, to_voice: toVoice },
  );
  return res.data;
}

export async function regenerateTtsLine(
  videoId: string,
  index: number,
  voiceType: string,
): Promise<{ status: string; index: number; voice_type: string }> {
  const res = await api.post<{
    status: string;
    index: number;
    voice_type: string;
  }>(`/tts/${videoId}/regenerate-line`, { index, voice_type: voiceType });
  return res.data;
}

export async function rebuildFullAudio(
  videoId: string,
  opts?: { muteOriginal?: boolean; originalGainDb?: number },
): Promise<{ status: string; audio_url: string; size: number }> {
  const res = await api.post<{
    status: string;
    audio_url: string;
    size: number;
  }>(`/tts/${videoId}/rebuild-full-audio`, {
    mute_original: opts?.muteOriginal ?? true,
    original_gain_db: opts?.originalGainDb ?? 0,
  });
  return res.data;
}

export interface AlignmentIssue {
  index: number;
  text: string;
  start: number;
  end: number;
  srt_duration: number;
  audio_duration: number;
  overshoot: number;
  voice_type: string;
  display_name: string;
}

export async function checkTtsAlignment(
  videoId: string,
  lang = "vi",
): Promise<{ issues: AlignmentIssue[]; total: number; checked: number }> {
  const res = await api.get<{
    issues: AlignmentIssue[];
    total: number;
    checked: number;
  }>(`/tts/${videoId}/check-alignment`, { params: { lang } });
  return res.data;
}

export async function setTtsSpeed(
  videoId: string,
  index: number,
  speed: number,
): Promise<{
  status: string;
  index: number;
  speed: number;
  new_duration: number;
}> {
  const res = await api.post<{
    status: string;
    index: number;
    speed: number;
    new_duration: number;
  }>(`/tts/${videoId}/set-speed`, { index, speed });
  return res.data;
}

export function getTtsAudioUrl(videoId: string, index: number): string {
  return `/api/tts/${videoId}/audio/${index}`;
}

export async function rewriteSrtLine(
  videoId: string,
  index: number,
  mode: "shorter" | "manual",
  currentText?: string,
  manualText?: string,
): Promise<{ status: string; index: number; text: string }> {
  const res = await api.post<{ status: string; index: number; text: string }>(
    `/srt/${videoId}/rewrite-line`,
    { index, mode, text: currentText, manual_text: manualText },
  );
  return res.data;
}

export async function capCutPreview(
  voice: string,
  text?: string,
): Promise<Blob> {
  const res = await api.post<Blob>(
    "/capcut/preview",
    { voice, text },
    { responseType: "blob" },
  );
  return res.data;
}

export async function getGoogleTtsVoices(
  lang = "vi-VN",
): Promise<CapCutVoice[]> {
  const res = await api.get<CapCutVoice[]>("/google-tts/voices", {
    params: { lang },
  });
  return res.data;
}

export async function googleTtsPreview(
  voice: string,
  text?: string,
): Promise<Blob> {
  const res = await api.post<Blob>(
    "/google-tts/preview",
    { voice, text },
    { responseType: "blob" },
  );
  return res.data;
}

export async function clearTempData(): Promise<{
  cleared: boolean;
  subdirs_wiped: number;
}> {
  const res = await api.post("/temp/clear");
  return res.data;
}

export interface SubtitleStyle {
  font_family: string;
  font_size: number;
  text_color: string;
  outline_color: string;
  outline_width: number;
  bold: boolean;
  italic: boolean;
  box_enabled: boolean;
  box_color: string;
  box_opacity: number;
  box_radius: number;
  box_border_color: string;
  box_border_width: number;
  margin_v: number;
  margin_h: number;
}

export interface WatermarkPreset {
  id: string;
  name: string;
  text: string;
  has_logo: boolean;
  logo_name: string;
  active: boolean;
}

export interface AppConfig {
  has_gemini_key: boolean;
  gemini_api_key: string;
  gemini_api_keys: string[];
  has_tts_credentials: boolean;
  google_tts_credentials: string;
  tts_credentials_info: string;
  has_fal_key: boolean;
  fal_key: string;
  auto_context_enabled: boolean;
  subtitle_style: SubtitleStyle;
  watermark_text: string;
  has_watermark_logo: boolean;
  watermark_logo_name: string;
  watermark_presets: WatermarkPreset[];
  active_watermark_preset: string;
  has_tiktok_config?: boolean;
  tiktok_client_key?: string;
  tiktok_client_secret?: string;
  tiktok_redirect_uri?: string;
  has_facebook_config?: boolean;
  facebook_app_id?: string;
  facebook_app_secret?: string;
  facebook_page_id?: string;
  facebook_page_access_token?: string;
  facebook_graph_api_version?: string;
  facebook_default_publish?: boolean;
}

export async function getAppConfig(): Promise<AppConfig> {
  const res = await api.get<AppConfig>("/config");
  return res.data;
}

export async function saveAppConfig(body: {
  gemini_api_key?: string;
  gemini_api_keys?: string[];
  google_tts_json?: string;
  fal_key?: string;
  auto_context_enabled?: boolean;
  subtitle_style?: Partial<SubtitleStyle>;
  watermark_text?: string;
  tiktok_client_key?: string;
  tiktok_client_secret?: string;
  tiktok_redirect_uri?: string;
  facebook_app_id?: string;
  facebook_app_secret?: string;
  facebook_page_id?: string;
  facebook_page_access_token?: string;
  facebook_graph_api_version?: string;
  facebook_default_publish?: boolean;
}): Promise<{ status: string; error?: string; saved?: string[] }> {
  const res = await api.post("/config", body);
  return res.data;
}

export interface PipelinePreset {
  id: string;
  name: string;
  config: Record<string, unknown>;
  created_at?: string;
}

export async function getPipelinePresets(): Promise<{
  presets: PipelinePreset[];
}> {
  const res = await api.get<{ presets: PipelinePreset[] }>(
    "/config/pipeline-presets",
  );
  return res.data;
}

export async function createPipelinePreset(
  name: string,
  config: Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  const res = await api.post<{ id: string; name: string }>(
    "/config/pipeline-presets",
    { name, config },
  );
  return res.data;
}

export async function deletePipelinePreset(id: string): Promise<void> {
  await api.delete(`/config/pipeline-presets/${id}`);
}

export async function uploadWatermarkLogo(
  file: File,
): Promise<{ status: string; watermark_logo_name?: string }> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await api.post("/config/logo", fd);
  return res.data;
}

export async function deleteWatermarkLogo(): Promise<{
  status: string;
  removed?: boolean;
}> {
  const res = await api.delete("/config/logo");
  return res.data;
}

export function watermarkLogoUrl(): string {
  return "/api/config/logo";
}

// ── Watermark presets (nhiều bộ text + logo) ──

export async function createWatermarkPreset(body: {
  name: string;
  text: string;
}): Promise<{ status: string; preset_id?: string }> {
  const res = await api.post("/config/watermark/presets", body);
  return res.data;
}

export async function updateWatermarkPreset(
  presetId: string,
  body: { name?: string; text?: string },
): Promise<{ status: string }> {
  const res = await api.put(`/config/watermark/presets/${presetId}`, body);
  return res.data;
}

export async function deleteWatermarkPreset(
  presetId: string,
): Promise<{ status: string; removed?: boolean }> {
  const res = await api.delete(`/config/watermark/presets/${presetId}`);
  return res.data;
}

export async function setActiveWatermarkPreset(
  presetId: string,
): Promise<{ status: string }> {
  const res = await api.post("/config/watermark/active", {
    preset_id: presetId,
  });
  return res.data;
}

export async function uploadPresetLogo(
  presetId: string,
  file: File,
): Promise<{ status: string; watermark_logo_name?: string }> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await api.post(`/config/watermark/presets/${presetId}/logo`, fd);
  return res.data;
}

export async function deletePresetLogo(
  presetId: string,
): Promise<{ status: string; removed?: boolean }> {
  const res = await api.delete(`/config/watermark/presets/${presetId}/logo`);
  return res.data;
}

export function presetLogoUrl(presetId: string): string {
  return `/api/config/watermark/presets/${presetId}/logo`;
}

// ── YouTube uploader (client_secrets.json) ──

export interface YoutubeConfig {
  has_client_secrets: boolean;
  has_request_token: boolean;
  has_binary: boolean;
  secrets_path: string;
}

export async function getYoutubeConfig(): Promise<YoutubeConfig> {
  const res = await api.get<YoutubeConfig>("/youtube/config");
  return res.data;
}

export async function saveYoutubeSecrets(
  content: string,
): Promise<{ status: string; path?: string }> {
  const res = await api.post("/youtube/config", { content });
  return res.data;
}

// ── YouTube channels (multi-account) ──

export interface YouTubeChannelInfo {
  id: string;
  name: string;
  has_client_secrets: boolean;
  has_request_token: boolean;
  created_at: string;
}

export interface YouTubeChannelDetail {
  id: string;
  name: string;
  client_secrets: string;
  has_client_secrets: boolean;
  has_request_token: boolean;
}

export async function listYoutubeChannels(): Promise<{
  channels: YouTubeChannelInfo[];
}> {
  const res = await api.get("/config/youtube-channels");
  return res.data;
}

export async function getYoutubeChannelDetail(
  id: string,
): Promise<YouTubeChannelDetail> {
  const res = await api.get(`/config/youtube-channels/${id}`);
  return res.data;
}

export async function createYoutubeChannel(
  name: string,
  client_secrets: string,
): Promise<{ status: string; channel_id: string; name: string }> {
  const res = await api.post("/config/youtube-channels", {
    name,
    client_secrets,
  });
  return res.data;
}

export async function updateYoutubeChannel(
  id: string,
  data: { name?: string; client_secrets?: string },
): Promise<{ status: string }> {
  const res = await api.put(`/config/youtube-channels/${id}`, data);
  return res.data;
}

export async function deleteYoutubeChannel(
  id: string,
): Promise<{ status: string; removed: boolean }> {
  const res = await api.delete(`/config/youtube-channels/${id}`);
  return res.data;
}

export async function activateYoutubeChannel(
  id: string,
): Promise<{ status: string; active_youtube_channel: string }> {
  const res = await api.post(`/config/youtube-channels/${id}/activate`);
  return res.data;
}

// ── Telegram notifications ──

export interface TelegramConfig {
  has_bot_token: boolean;
  bot_name: string;
  connected_chats: Array<{
    chat_id: number;
    name: string;
    connected_at: string;
  }>;
}

export interface TelegramQR {
  registration_token: string;
  qr_data: string;
  expires_in: number;
}

export async function getTelegramConfig(): Promise<TelegramConfig> {
  const res = await api.get<TelegramConfig>("/telegram/config");
  return res.data;
}

export async function saveTelegramToken(
  bot_token: string,
): Promise<{ status: string; bot_name: string }> {
  const res = await api.post("/telegram/config", { bot_token });
  return res.data;
}

export async function deleteTelegramConfig(): Promise<{ status: string }> {
  const res = await api.delete("/telegram/config");
  return res.data;
}

export async function getTelegramQR(): Promise<TelegramQR> {
  const res = await api.post<TelegramQR>("/telegram/connect");
  return res.data;
}

export async function disconnectTelegramChat(
  chat_id: number,
): Promise<{ status: string; removed: boolean }> {
  const res = await api.post(`/telegram/disconnect/${chat_id}`);
  return res.data;
}

export async function sendTelegramTest(): Promise<{
  status: string;
  sent: number;
}> {
  const res = await api.post("/telegram/test");
  return res.data;
}
