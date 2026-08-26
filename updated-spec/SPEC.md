# SPEC — Các logic đã sửa/chốt mới kể từ commit `3586e7b`

> **Phạm vi:** `3586e7b` (2026-08-22) → `ea0c3e9` (2026-08-26, HEAD)
> **Repo:** SubTitleExtractor_beta · branch `haovpn-beta`
> Tài liệu này mô tả trạng thái logic **cuối cùng (final)** sau toàn bộ chuỗi fix, không mô tả lịch sử trung gian.

---

## 1. Ghép giọng nói — `combine_tts_mp3` (`backend/app/services/dub_service.py`)

### Vấn đề gốc
- Flat amix 1 lệnh ffmpeg cho 3.000–4.000 entry → filter graph quá lớn, chậm/crash server.
- Bản chunking cũ (19/8): chunk MP3 + concat tích lũy encoder delay ~24ms/chunk → voice trôi dần so với sub.
- `amix=duration=longest` chỉ xuất tới **sample có tiếng cuối cùng** — phần im lặng cuối chunk bị cắt bỏ; `-t` chỉ truncat được, không kéo dài được → chunk ngắn hơn chuẩn → các chunk sau bị **kéo lên sớm dồn tích lũy** (triệu chứng: voice ở phút cuối sớm hơn sub ~5s).

### Logic cuối cùng
1. **Chunking 300 giây**, mỗi chunk = 1 lệnh ffmpeg riêng.
2. **File trung gian là WAV** (`.chunk_*.wav`) — không có MP3 encoder delay.
3. **Tempo xử lý inline** trong filter graph (`{tempo}adelay=…`) — không tạo file `.tempo_*`.
4. **Mọi chunk ép đúng độ dài chuẩn**: `amix=…,apad=whole_dur={dur}` — apad *có giới hạn* (pad tới đúng N giây rồi dừng, khác `apad` vô hạn gây lỗi trước đây); kèm `-t {dur}` làm belt-and-suspenders.
   - Chunk thường: `dur = 300.000`
   - Chunk cuối: `dur = max(0.5, last_end − chunk_start)`
5. **Delay tuyệt đối trong chunk**: `delay_ms = int((start − c×300) × 1000)`; concat WAV → convert MP3 **một lần duy nhất** ở bước cuối (`full_voice.mp3`).
6. **ffprobe song song** đo duration: `ThreadPoolExecutor(8–32 workers)` (~30 phút → ~1–2 phút).
7. **Validate entry**: bỏ start<0, end≤start, start>24h; clamp duration >600s.
8. **Dọn file rác sớm**: `.chunk_*.wav`, `.chunk_list.txt` ở đầu `build_full_audio` và `combine_tts_mp3`.
9. **Kiểm tra ổ đĩa** `_ensure_free_space()` trước Demucs và combine — thiếu chỗ thì fail nhanh với thông báo rõ.

### Bất biến đảm bảo
```
vị trí entry T trong chunk c = c×300 + (T − c×300) = T   (±0ms)
Số chunk không tạo drift; video 2h (24 chunks) hay 4h (48 chunks) đều ±0ms.
```

### Verify
```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 backend/temp/tts/<id>/full_voice.mp3
# phải ≥ end của entry cuối SRT (trước đây thiếu 5.1s trên video test)
```

---

## 2. Giao thức mảng Gemini — `backend/app/services/gemini_array.py` (FILE MỚI)

### Nguyên tắc
Gemini **không bao giờ nhìn thấy index/timestamp SRT**. Timeline nằm hoàn toàn ở backend.

### API
| Hàm | Chức năng |
|---|---|
| `build_numbered_payload(texts)` | Render `0\|text\n1\|text…`; collapse xuống dòng trong text |
| `parse_numbered_response(text, n)` | Tách theo số đầu dòng, split `\|` **lần đầu tiên** (text chứa `\|` vẫn an toàn); bỏ vị trí ngoài `[0,n)`; duplicate giữ lần đầu |
| `gemini_map_texts(texts, instruction, system_instruction, temperature, max_attempts=3, log_fn)` | Vòng lặp gọi Gemini: thiếu slot nào → retry nhắc đích danh vị trí thiếu; hết vòng vẫn hụt → **giữ text gốc đúng slot**; lỗi mạng → giữ nguyên toàn bộ. Luôn trả list đúng độ dài đầu vào |

### Ngữ nghĩa merge giữa các lượt retry
Slot đã có kết quả từ lượt trước **giữ nguyên** (chống lật kết quả), retry chỉ lấp chỗ trống.

---

## 3. Dịch thuật — `backend/app/services/translation_service.py`

### Đã xoá
- `_reconcile_batch()`, `_extract_indices()`, `_clean_gemini_response()` — không cần nữa vì cấu trúc được bảo đảm bởi giao thức mảng.
- Khối retry "dò echo" (so sánh text đầu batch rồi dịch lại per-line).

### Logic cuối cùng (`translate_srt`)
- Batch **50 entries** → chỉ gửi `[e.text]` dạng dòng đánh số → `gemini_map_texts` → **zip 1:1** vào entries gốc: `index/start/end/startLabel/endLabel` giữ nguyên tuyệt đối, chỉ thay `text`.
- Prompt mới: quy tắc `position|translation`, cấm merge/split/skip, `{line_hint}` nhắc số dòng.
- Context patch (`_build_patch_context_note`) cũng gửi dạng dòng đánh số, không còn SRT.
- `retranslate_untranslated`: chọn dòng chưa dịch (fuzzy ≥95% với gốc) → gửi mảng text → splice về theo index.
- Log mỗi batch: `dịch xong N dòng (M dòng thay đổi)`; nếu 0 dòng đổi → cảnh báo có thể Gemini echo.

### Bất biến đã verify
Output SRT có **cùng số lượng dòng và timestamp giống hệt input** (test mock 5 dòng: 100% giữ nguyên).

---

## 4. Risk-check — `backend/app/services/risk_check_service.py`

### Phân tầng mới
| Loại risk | Xử lý bởi | Chi tiết |
|---|---|---|
| `TIMELINE_OVERLAP` | **CODE** | `_check_timeline_overlaps()`: `cur.start < prev.end − 0.001` (tolerance 1ms). Xác định 100%, không phụ thuộc AI |
| `NOT_TRANSLATED`, `ADJACENT_SIMILAR` | **Gemini** | Payload dòng đánh số `N\|text` (batch 50, overlap 10 như cũ); trả JSON `[{"i": <position>, …}]` |

- Map `i → batch[i]` trực tiếp (hợp lệ hoá phạm vi `[0, len(batch))`); chấp nhận key `i`/`position`/`index`.
- Dedup báo cáo bằng `seen_indexes` trên `entry.index` thật (không còn phép cộng `batch_start + local_index` dễ lệch).
- Prompt Gemini không còn chứa quy tắc timeline.

---

## 5. Hardcode burn — `backend/app/services/hardcode_service.py`

- `_burn_parallel`: `ThreadPoolExecutor` + `as_completed`, **try/except từng segment** — 1 segment lỗi không làm chết cả job (trước đây 1 exception làm rơi toàn bộ).
- Timeout scale theo độ dài video (`_dur_timeout(dur, per_sec, floor)` — dùng chung pattern với dub).

---

## 6. TTS — `tts_service.py` & `capcut_tts_client.py`

- **Bỏ validate kích thước file** TTS trả về (CapCut đôi khi trả file nhỏ hợp lệ; check cũ làm rớt entry oan → mất tiếng giữa video).
- Synthesis chạy song song (ThreadPoolExecutor); dedup im lặng `_texts_similar`.

---

## 7. Chắn SRT hỏng — `srt_utils.py`

- `_MAX_SRT_TIME = 48h`. `parse_srt` **bỏ qua** entry có `start<0`, `end≤start`, hoặc timestamp >48h (vd `"999:59:59"` từ OCR hỏng — nguyên nhân từng khiến combine ghi file 70–80GB).
- Lưu ý: bỏ entry chứ không sửa giá trị.

---

## 8. Align — `align_service.py`

- Timeout extract audio scale theo độ dài: `max(120, int(dur × 1.5))` thay vì 120s cố định (clip dài 2–3h trước đây chết giữa chừng).

---

## 9. Vận hành — `dev.sh` & frontend

| Thay đổi | Lý do |
|---|---|
| `STE_NO_RELOAD=1 ./dev.sh` → uvicorn KHÔNG `--reload` | Job dài 2–4h: reloader tự kill/restart worker giữa chừng + che traceback khi crash. Job dài phải chạy chế độ này |
| `ulimit -n 4096` trong dev.sh | Pipeline hàng nghìn file TTS mở cùng lúc |
| Frontend cap log: `pipeline-store.ts` 500 dòng, `ResultPage.tsx` 500, `video/[id]` 80 | Video dài sinh hàng chục nghìn dòng log → treo tab |

---

## 10. Issue ĐÃ BIẾT nhưng CHƯA fix (backlog)

| # | Vấn đề | Trạng thái |
|---|---|---|
| K1 | **Sub lệch video trên clip dài (VFR)**: `stream_frames_generator` tính `timestamp = idx / CAP_PROP_FPS` giả định CFR. Video VFR → một khối sub nhảy sớm rồi tự hết. Fix hướng: dùng `CAP_PROP_POS_MSEC` (PTS thật) + fallback | ⏳ Chưa sửa |
| K2 | `merge_similar_adjacent` nới end dòng trước **không giới hạn**; chạy 3 chỗ (auto-check sau OCR, sau translate, tự động trong `build_full_audio`) | ⏳ Chưa sửa |
| K3 | Timestamp frame gốc sai kéo theo voice sai (voice build từ SRT nên luôn khớp sub, lệch cùng nhau so với video) | Cùng gốc K1 |

---

## Kiểm chứng tổng hợp đã chạy

1. `ast.parse` pass cả `gemini_array.py`, `translation_service.py`, `risk_check_service.py`.
2. Parser: đủ/thiếu/thừa/duplicate/text chứa `|`/response rỗng — pass toàn bộ.
3. `gemini_map_texts`: đủ 1 lượt; thiếu → retry lấp slot; hụt hoài → fallback gốc đúng slot; Gemini sập → giữ nguyên.
4. Timeline-invariance end-to-end `translate_srt` (mock): 5/5 dòng giữ nguyên index/start/end.
5. Risk-check overlap code phát hiện đúng entry vi phạm; prompt Gemini đã tách khỏi timeline.
6. Mô phỏng ffmpeg thật cho fix chunk: chunk cũ 295.083s (thiếu silence đuôi) vs chunk mới 300.000s chính xác.
