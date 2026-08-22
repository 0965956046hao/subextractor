# BUILD — Hướng dẫn build app desktop (Tauri)

Hướng dẫn step-by-step để đóng gói lại **SubTitle Extractor.app** khi có thay đổi code.

## Kiến trúc app

App là 1 bundle duy nhất (`src-tauri/target/release/bundle/macos/SubTitle Extractor.app`) chứa nhiều service, mỗi service build độc lập:

| Service | Vị trí trong `.app` | Build khi sửa |
|---|---|---|
| Frontend (Next.js standalone + Node) | `Resources/frontend/.next/standalone` + `Resources/node/` | `frontend/src` |
| Backend OCR (FastAPI + RapidOCR) | `Resources/backend/` (PyInstaller onedir) | `backend/app` |
| capcut-tts-api | `Resources/capcut-tts-api/` | `capcut-tts-api/` |

**Tools (ffmpeg, demucs, youtubeuploader) KHÔNG bundle vào app.** Khi mở app lần đầu, chúng được tải về vào data dir (`~/Library/Application Support/com.subextractor.desktop/tools/`) từ host cấu hình (`STE_TOOLS_URL` hoặc `DEFAULT_TOOLS_URL` trong `src-tauri/src/tools.rs`). Mỗi tool có marker `.ten-tool.installed` — có marker là bỏ qua, không tải lại.

## Yêu cầu môi trường

- macOS arm64 (Apple Silicon)
- Xcode command line tools (`xcode-select --install`)
- Rust + cargo: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Node.js 18+ (npm)
- Python 3.13+ cho backend venv; 3.14+ cho `.venv-demucs`
- Tauri CLI (global): `npm i -g @tauri-apps/cli`

---

## Quy trình build (khi có update code)

> Gõ lệnh từ **repo root** (`subextractor/`) trừ khi có ghi chú khác.

### Bước 0 — Chỉ build những gì đã sửa

- Chỉ sửa **frontend** → chạy **Bước 1** + **Bước 5**
- Chỉ sửa **backend** (`backend/app`) → chạy **Bước 2** + **Bước 5**
- Sửa **capcut-tts-api** → **Bước 3** + **Bước 5**
- Sửa **demucs / torch** → **Bước 2b** + **Bước 4** (đóng gói tools lại) + **Bước 5**
- Sửa **code Rust** (`src-tauri/src`) → chỉ cần **Bước 5**
- Sửa **tools.rs / cần đóng gói lại tools** → **Bước 4** + upload archive mới

**LƯU Ý QUAN TRỌNG:** Bước 1 (frontend) chạy trước Bước 2/3 để `.next-prod` không bị ghi đè. **KHÔNG** chạy `npm run dev` sau khi build — `next dev` xóa `.next/standalone` khiến bản build hỏng.

### Bước 1 — Build frontend (nếu sửa `frontend/`)

```bash
cd frontend
npm run build        # next build → copy sang .next-prod (staging)
cd ..
```

Sản phẩm: `frontend/.next-prod/` (được tauri bundle vào `Resources/frontend/.next/standalone`).

Test nhanh bản dev: `npm run dev` (chỉ dev, sau đó build lại Bước 1 nếu muốn đóng gói).

### Bước 2 — Build backend (nếu sửa `backend/app/`)

```bash
cd backend
bash build-backend.sh   # pyinstaller backend.spec + codesign ad-hoc
cd ..
```

Sản phẩm: `backend/dist/backend/`.

**Bắt buộc** phải chạy bằng script này (không chạy `pyinstaller` tay) vì sau build phải `codesign --force --deep --sign -` — nếu thiếu, `.so`/`.dylib` chưa ký làm app treo khi load RapidOCR.

Script cũng tự **deduplicate dylib**: PyInstaller copy FFmpeg dylib vừa vào `_internal/` root (nơi `@rpath` resolve) vừa vào `cv2/.dylibs/` (package data) dưới dạng symlink. Nếu không dọn, Tauri bundler sẽ "giải" symlink thành file thật → app phình thêm ~90MB. Script materialize symlink ở root và xóa bản `.dylibs` thừa.

**Google TTS dùng REST, không dùng gRPC:** `backend/app/services/tts_service.py` + `health_service.py` gọi thẳng `https://texttospeech.googleapis.com/v1/text:synthesize` và `/v1/voices` bằng `google-auth` (lấy OAuth2 token) + `httpx`. Không cần (và không bundle) `google-cloud-texttospeech` / `grpcio` / `grpcio-status` — giảm ~19MB. `backend.spec` exclude `grpc`, `grpcio`, `google.cloud` để chắc chắn không lọt vào bundle.

### Bước 2b — Build demucs (chỉ khi sửa phần dùng demucs)

```bash
cd backend
bash build-demucs.sh    # cần .venv-demucs đã có (xem script)
cd ..
```

### Bước 3 — Build capcut-tts-api (nếu sửa)

```bash
cd capcut-tts-api
bash build-capcut.sh
cd ..
```

### Bước 4 — Đóng gói tools (chỉ khi tools thay đổi / lần đầu)

Tạo 3 archive tải về khi mở app lần đầu:

```bash
bash pack-tools.sh
```

Sản phẩm: `tools-dist/ffmpeg.tar.gz`, `demucs.tar.gz`, `youtubeuploader.tar.gz` (~283MB). **Upload các file này lên host** và set `STE_TOOLS_URL` khi chạy app (hoặc sửa `DEFAULT_TOOLS_URL` trong `src-tauri/src/tools.rs` rồi build lại). Nếu không upload, app sẽ báo `[tools] ... install failed` và các tính năng cần ffmpeg/demucs/youtubeuploader không dùng được.

### Bước 5 — Build app Tauri

```bash
npx tauri build
```

Sản phẩm:
- `.app`: `src-tauri/target/release/bundle/macos/SubTitle Extractor.app`
- (nếu DMG thành công) `src-tauri/target/release/bundle/dmg/SubTitle Extractor_<version>_aarch64.dmg`

> `beforeBuildCommand` tự chạy `npm run build` trong `frontend/` (Tauri CLI chạy hook với cwd = `frontend/`). Nếu chạy Bước 1 rồi, bước này chỉ cần cho phần Rust + bundle.

### Bước 5 — Smoke test (mở app)

Lần đầu mở, app tự tải tools vào data dir (theo dõi log: `[tools] ffmpeg ready`, `[tools] demucs ready`, `[tools] youtubeuploader ready`). Chờ tools xong rồi kiểm tra:

```bash
open "src-tauri/target/release/bundle/macos/SubTitle Extractor.app"
```

Kiểm tra:

```bash
curl -s http://127.0.0.1:8000/api/health        # backend → {"status":"ok","version":"2.0.0"}
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/    # frontend → 200
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8100/api/voices   # capcut → 200
curl -s http://127.0.0.1:8000/api/youtube/config   # youtube: has_binary + has_client_secrets = true
ls "$HOME/Library/Application Support/com.subextractor.desktop/tools/"   # .ffmpeg.installed, .demucs.installed, .youtubeuploader.installed
```

Thoát app + dọn port:

```bash
pkill -f "SubTitle Extractor"
lsof -ti tcp:3000,tcp:8000,tcp:8100 | xargs kill -9
```

---

## Dọn dẹp khi build lỗi

- Build backend treo khi chạy: build lại rồi `codesign --force --deep --sign - dist/backend`
- `.next-prod` thiếu: chạy lại `cd frontend && npm run build`
- Muốn build sạch Rust: `cd src-tauri && cargo clean && cd .. && npx tauri build`
- Xoá app cũ: `rm -rf src-tauri/target/release/bundle`

## Cấu trúc runtime (data dir)

Khi app chạy, dữ liệu ghi được nằm ở:

```
~/Library/Application Support/com.subextractor.desktop/
├── youtube/client_secrets.json   # copy tự động từ template lần đầu chạy
├── youtube/request.token         # tạo sau khi OAuth Google lần đầu
├── tools/                        # tải tự động lần đầu mở app (ffmpeg, demucs, youtubeuploader)
│   ├── .ffmpeg.installed         # marker: có rồi thì không tải lại
│   ├── .demucs.installed
│   ├── .youtubeuploader.installed
│   ├── ffmpeg + lib/
│   ├── demucs/
│   └── youtubeuploader
└── temp/                         # videos, srt, frames, ...
```

Muốn ép app tải lại tools (sau khi có archive mới): xóa marker + thư mục tương ứng trong `tools/`, đóng mở app. Muốn reset toàn bộ dữ liệu app: xóa thư mục data (app tự tạo lại khi mở).

## Share app cho máy Mac khác

App build ra là **ad-hoc signed** (không có Apple Developer Certificate). Trên máy khác, Gatekeeper sẽ chặn "unidentified developer" khi mở lần đầu. Có 2 cách:

1. **Developer ID + notarize** (mở thẳng không warning, cần tài khoản Apple Developer $99/năm):
   ```bash
   codesign --deep --force --sign "Developer ID Application: Tên (TEAMID)" \
     "src-tauri/target/release/bundle/macos/SubTitle Extractor.app"
   # đóng gói DMG rồi submit:
   xcrun notarytool submit --apple-id "email" --team-id TEAMID --wait "SubTitle Extractor_0.1.0_aarch64.dmg"
   xcrun stapler staple "src-tauri/target/release/bundle/macos/SubTitle Extractor.app"
   ```
2. **Không cần cert** — máy nhận làm 1 lần: click phải app → **Open**, hoặc chạy `xattr -cr "SubTitle Extractor.app"` rồi mở bình thường.
