# BUILD — Hướng dẫn build app desktop (Tauri)

Hướng dẫn step-by-step để đóng gói lại **SubTitle Extractor.app** khi có thay đổi code.

## Kiến trúc app

App là 1 bundle duy nhất (`src-tauri/target/release/bundle/macos/SubTitle Extractor.app`) chứa nhiều service, mỗi service build độc lập:

| Service | Vị trí trong `.app` | Build khi sửa |
|---|---|---|
| Frontend (Next.js standalone + Node) | `Resources/frontend/.next/standalone` + `Resources/node/` | `frontend/src` |
| Backend OCR (FastAPI + RapidOCR) | `Resources/backend/` (PyInstaller onedir) | `backend/app` |
| demucs (tách vocal, chạy torch) | `Resources/tools/demucs/` | `backend/services/...` dùng demucs |
| capcut-tts-api | `Resources/capcut-tts-api/` | `capcut-tts-api/` |
| ds2api (download) | `Resources/ds2api/ds2api` | `ds2api/` |
| youtubeuploader | `Resources/tools/youtubeuploader` | `youtubeuploader/` (Go) |
| ffmpeg + dylib | `Resources/tools/ffmpeg` + `Resources/tools/lib/` | không build lại (copy sẵn) |

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
- Sửa **ds2api** → **Bước 4** + **Bước 5**
- Sửa **demucs / torch** → **Bước 2b** + **Bước 5** (hiếm khi cần)

**LƯU Ý QUAN TRỌNG:** Bước 1 (frontend) chạy trước Bước 2/3/4 để `.next-prod` không bị ghi đè. **KHÔNG** chạy `npm run dev` sau khi build — `next dev` xóa `.next/standalone` khiến bản build hỏng.

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

### Bước 4 — Build ds2api (nếu sửa)

```bash
cd ds2api
go build -o ds2api ./cmd/ds2api
cd ..
```

### Bước 5 — Build app Tauri

```bash
npx tauri build
```

Sản phẩm:
- `.app`: `src-tauri/target/release/bundle/macos/SubTitle Extractor.app`
- (nếu DMG thành công) `src-tauri/target/release/bundle/dmg/SubTitle Extractor_<version>_aarch64.dmg`

> `beforeBuildCommand` tự chạy `npm run build` trong `frontend/` (Tauri CLI chạy hook với cwd = `frontend/`). Nếu chạy Bước 1 rồi, bước này chỉ cần cho phần Rust + bundle.

### Bước 6 — Smoke test (mở app)

```bash
open "src-tauri/target/release/bundle/macos/SubTitle Extractor.app"
```

Kiểm tra:

```bash
curl -s http://127.0.0.1:8000/api/health        # backend → {"status":"ok","version":"2.0.0"}
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/    # frontend → 200
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5001/    # ds2api → 200
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8100/api/voices   # capcut → 200
curl -s http://127.0.0.1:8000/api/youtube/config   # youtube: has_binary + has_client_secrets = true
```

Thoát app + dọn port:

```bash
pkill -f "SubTitle Extractor"
lsof -ti tcp:3000,tcp:8000,tcp:8100,tcp:5001 | xargs kill -9
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
├── ds2api/                       # config.json tự sinh từ config.example.json
└── temp/                         # videos, srt, frames, ...
```

Muốn reset toàn bộ dữ liệu app: xóa thư mục này (app sẽ tự tạo lại cấu trúc khi mở).
