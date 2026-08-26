# MERGE SPEC — Merge `haovpn-beta` vào `haovpn`

> **Merge commit:** `5a4e65e`
> **Base so sánh:** `3586e7b` (merge-base của hai nhánh)
> **HEADs:** `haovpn` = `08bc67b`, `haovpn-beta` = `abdd219`
> **Tài liệu tham chiếu:** `updated-spec/SPEC.md` (spec fix của haovpn-beta, commit `abdd219`)
> **Nguyên tắc merge:** giữ fix của `haovpn-beta`; chỉ bỏ nơi nhánh `haovpn` đã tự xử lý cùng lớp lỗi; không mất tính năng Telegram bot + voice map + hardcode mới của `haovpn`.

---

## 1. Kết quả tổng quan

| File | Cách xử lý | Ghi chú |
|---|---|---|
| `backend/app/services/gemini_array.py` | **Thêm mới từ beta** | File mới, không xung đột |
| `backend/app/services/dub_service.py` | **Gộp thủ công** | Thân `combine_tts_mp3` lấy beta; `build_full_audio` gộp cả 2 phía |
| `backend/app/services/translation_service.py` | **Gộp thủ công** | Protocol mảng của beta + voice map/diarization của haovpn |
| `backend/app/services/risk_check_service.py` | **Gộp imports** | `_srt_best_path` (haovpn) + `build_numbered_payload` (beta) |
| `backend/app/services/hardcode_service.py` | **Giữ nguyên haovpn** | Fix segment-pool của beta không còn áp dụng được |
| `backend/app/services/tts_service.py` | Auto-merge OK | Cả 2 phía giữ trọn |
| `backend/app/services/srt_utils.py` | Từ beta (auto) | Chặn SRT hỏng >48h |
| `backend/app/services/align_service.py` | Từ beta (auto) | Timeout extract audio scale theo duration |
| `backend/app/services/capcut_tts_client.py` | Auto (blank line) | Trivial |
| `dev.sh` | Từ beta (auto) | `ulimit -n 4096` + `STE_NO_RELOAD=1` |
| `frontend/src/components/ResultPage.tsx` | **Lấy beta** | Cap 500 dòng log + clear dedup set |
| `frontend/src/stores/pipeline-store.ts` | Auto-merge OK | Cap 500 log đã vào (`patch` helpers) |
| `.codegraph/daemon.pid`, `frontend/tsconfig.tsbuildinfo` | Giữ haovpn | Runtime/build artifact |

---

## 2. Chi tiết quyết định từng conflict

### 2.1 `dub_service.py` — 5 vùng conflict

1. **Imports** → giữ cả `os` (beta: `_ensure_free_space`) lẫn `re` (haovpn: `_voice_lang_from_name`).
2. **Đầu `combine_tts_mp3`** → **lấy beta**: `CHUNK_SECONDS = 300.0`. Toàn bộ phần thân phía dưới đã auto-merge theo bản beta (WAV chunking + `apad=whole_dur` + tempo inline). Bản chunking 600s dùng file `.combine_*.mp3`/`.tempo_*.mp3` riêng của haovpn bị thay thế — đúng spec §1 (WAV trung gian không có encoder delay, mọi chunk ép đúng độ dài chuẩn → ±0ms drift).
3. **`build_full_audio`: dọn rác vs audio source** → **gộp cả hai**:
   - Beta: xoá stale `.chunk_*.wav`, `.chunk_list.txt`.
   - Haovpn: ưu tiên `audio_source = _merge_audio_path(video_id)` và `_srt_best_path(video_id)` (bản dịch).
   - Bổ sung: thêm `.combine_*.mp3`, `.tempo_*.mp3` vào pattern dọn rác để dọn nốt rác của cơ chế chunk cũ.
4. **Gọi `separate_instrumental`** → gộp: `_ensure_free_space(12.0, ...)` của beta + truyền `audio_source` của haovpn.
5. **Block mux `dubbed_video.mp4` cuối file** → **giữ haovpn** (xoá block): haovpn đã refactor sang `dub_audio_only` (không tạo dubbed_video.mp4 — hardcode tự mux); block của beta tham chiếu biến không tồn tại trong ngữ cảnh mới.

### 2.2 `translation_service.py` — 4 vùng conflict

Chiến lược: **beta làm nền** (protocol mảng), port tính năng additive của haovpn lên trên.

1. **Conflict lớn (107–457)**:
   - Giữ của haovpn: `_clean_gemini_response` (vẫn được `re_translate_line` dùng), `VOICE_MAP_PROMPT`, `generate_voice_map` (diarization + cross-batch memory), `_voice_map_path`/`load_voice_map`.
   - Bỏ theo beta: `_extract_indices`, `_reconcile_batch` (thay bằng bảo đảm cấu trúc từ protocol mảng), header `_build_base_prompt` 3 tham số.
   - Lấy signature mới của beta: `_build_patch_context_note(translated_texts: list[str], ...)`.
   - Sửa phát sinh: thêm `from pathlib import Path` (annotation `-> Path` của `_voice_map_path` thiếu import — latent bug có sẵn trên haovpn).
2. **`retranslate_untranslated`** → lấy beta: `gemini_map_texts` + zip theo index, không còn `_reconcile_batch`.
3. **Đầu `translate_srt`** → lấy beta (instruction dựng per-batch với `len(texts)`).
4. **Trong loop batch** → gộp cả hai: `progress_callback(bi+1, total_batches)` của haovpn + `instruction = _build_base_prompt(..., len(texts))` của beta.
5. **Sửa call-site** `re_translate_line`: `_build_base_prompt(..., n_lines=1)` khớp signature mới 4 tham số.
6. Giữ nguyên tail haovpn đã auto-merge: `multi_voice` → `generate_voice_map` sau khi dịch; `run_translate_sync` với `_progress`.

### 2.3 `risk_check_service.py`

Chỉ conflict imports. Gộp: `_srt_best_path` (risk-check chạy trên SRT đã dịch — fix Telegram `8ca9025` của haovpn) + `entries_to_srt` + `build_numbered_payload` (payload đánh số cho Gemini — spec §4). Phần thân spec §4 auto-merge trọn vẹn (TIMELINE_OVERLAP bằng code, tolerance 1ms).

### 2.4 `hardcode_service.py` — KHÔNG lấy fix của beta (có chủ đích)

Beta sửa `_burn_parallel`/`_burn_segment` (ThreadPoolExecutor thay ProcessPool, try/except từng segment, teardown fix — spec §5). Nhưng `haovpn` đã **viết lại toàn bộ bước hardcode** thành **1 lệnh FFmpeg duy nhất** (`scale → subtitles(libass) → overlay(logo) → drawtext(scroll)`, `-progress pipe:1`, Popen + watcher threads):
- Lớp lỗi beta fix (spawn macOS treo, teardown `'NoneType' object has no attribute 'values'`, 1 segment chết cả job) **không còn tồn tại** vì không còn worker pool.
- Không có timeout cứng trên encode → phù hợp video dài hơn cả timeout scale của beta.
→ Giữ nguyên bản haovpn. Không còn tham chiếu nào tới `burn_subtitles_pillow`/`_burn_parallel`/`_burn_segment` trong repo.

### 2.5 `ResultPage.tsx`

Lấy bản beta: cap log 500 dòng + clear `seenRef` khi vượt 2000 (spec §9) — vẫn giữ dedup logic của haovpn.

### 2.6 Các file auto-merge (đã verify giữ đúng fix)

- `tts_service.py`: song song hoá synthesis (ThreadPoolExecutor), dedup im lặng `_texts_similar`, fallback im lặng khi CapCut TTS lỗi (không phá job), throttle log mỗi 50 dòng.
- `pipeline-store.ts`: cap log 500 dòng ở các helper `appendLog`/`pushLog`.
- `video/[id]/page.tsx`: cap `.slice(-80)` có sẵn.
- `srt_utils.py`: `_MAX_SRT_TIME = 48h`, `parse_srt` bỏ entry start<0 / end≤start / quá 48h (chặn combine ghi file 70–80GB).
- `align_service.py`: timeout extract audio `max(120, dur × 1.5)`.
- `dev.sh`: `ulimit -n 4096`, `STE_NO_RELOAD=1` tắt `--reload` cho job dài.
- `gemini_array.py`: identical với beta.

---

## 3. Kiểm chứng đã chạy

1. `ast.parse` PASS cho 9 file backend thay đổi.
2. Import test PASS: `srt_utils`, `gemini_array`, `tts_service`, `translation_service`, `risk_check_service`, `dub_service`, `hardcode_service`, `align_service`, `capcut_tts_client` (stub `tenacity`/`google.*` — chưa cài trong venv, lỗi môi trường có sẵn, không liên quan merge).
3. Parser gemini_array: đủ/thiếu/thừa/duplicate/text chứa `|`/response rỗng — PASS toàn bộ.
4. Call-site `_build_base_prompt`: mọi lời gọi đều truyền 4 đối số hoặc `n_lines=` — PASS.
5. `npm run typecheck`: các lỗi TS đều **đã tồn tại trên HEAD trước merge** (verify bằng stash + typecheck lại) — không phải regression của merge.
6. Merge commit `5a4e65e` có đúng 2 parents: `08bc67b` (haovpn) + `abdd219` (haovpn-beta).
7. **Bổ sung sau merge** (`adf8278`): pyflakes bắt được 3 NameError runtime mà import-test bỏ sót — `_call_gemini`/`generate_voice_map` dùng `gemini_call_rotating`, `genai_generate_content_factory`, `_video_path` nhưng import top-level là bản slim của beta (beta đã xoá vì code của nó không còn dùng). Bài học: với merge giữ hàm từ cả 2 phía, phải chạy pyflakes/undefined-name scan, không chỉ test import.

---

## 4. Merge lần 2 — `origin/tinhptdv` (merge commit `0a5270c`)

3 commit mới kể từ `08bc67b`, auto-merge sạch, không conflict:

| File | Thay đổi |
|---|---|
| `start-be.sh` (mới) | Khởi động pinggy tunnel trước rồi mới chạy uvicorn — `STE_public_url` luôn fresh mỗi phiên (tunnel free 60min) |
| `frontend/src/stores/pipeline-store.ts` | Bỏ hardcode URL `zjzmt-...free.pinggy.net` → dùng `NEXT_PUBLIC_TUNNEL_URL` (frontend/.env.local); thêm `"User-Agent": "SubtitleExtractor/1.0"` vào `JSON_HEADERS`; thêm `mode: "watermark"` khi gửi Telegram Mini App button |

Verify: cap log 500 dòng của beta vẫn nguyên vẹn (dòng 1384/1447); các fix merge lần 1 không bị đụng tới.

---

## 5. Backlog kế thừa từ spec beta (chưa fix, không thuộc phạm vi merge)

| # | Vấn đề |
|---|---|
| K1 | Sub lệch video trên clip dài (VFR): `stream_frames_generator` giả định CFR |
| K2 | `merge_similar_adjacent` nới end dòng trước không giới hạn (chạy 3 chỗ) |
| K3 | Timestamp frame gốc sai kéo theo voice sai (cùng gốc K1) |
