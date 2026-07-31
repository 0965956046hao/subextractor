---
name: frontend-dev
description: Use ONLY when writing Next.js/TypeScript frontend code for SubTitleExtractor — upload page, region selector canvas, SRT preview/download. Covers App Router, Server/Client components, Canvas API, Tailwind CSS, axios.
---

# Frontend Development — SubTitleExtractor

## Tech Stack
- Next.js 14+ (App Router), TypeScript
- Tailwind CSS
- Axios (API client)
- Canvas API (region selector)

## Project Structure
```
frontend/
├── public/
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   └── globals.css
│   ├── components/
│   │   ├── UploadPage.tsx       # 'use client' — drag & drop upload
│   │   ├── RegionSelector.tsx   # 'use client' — canvas drag-select region
│   │   └── ResultPage.tsx       # 'use client' — preview + download SRT
│   └── lib/
│       └── api.ts               # Axios API client
├── next.config.js
├── package.json
├── tailwind.config.js
└── tsconfig.json
```

## Component Tree
```
layout.tsx (root layout)
└── page.tsx (client component)
    ├── UploadPage
    │   ├── FileDropZone (drag & drop)
    │   └── VideoPreview (HTML5 video)
    ├── RegionSelector
    │   ├── Canvas (render frame + overlay)
    │   └── Controls (confirm region, adjust)
    └── ResultPage
        └── SRTPreview (srt text preview + download button)
```

## Next.js Conventions
- `'use client'` cho components có state, event handlers, Canvas, hoặc gọi API
- Layout server component mặc định, page client component
- Config `next.config.js` với `rewrites` để proxy API tới backend (tránh CORS)
- Dùng `next.config.js`:
  ```js
  async rewrites() {
    return [
      { source: '/api/:path*', destination: 'http://localhost:8000/api/:path*' }
    ]
  }
  ```

## Canvas Region Selector
- Render frame lên canvas ở kích thước phù hợp
- MouseEvent: `mousedown` → `mousemove` → `mouseup` → rectangle
- Vẽ rectangle border + semi-transparent overlay khi kéo
- Tọa độ normalized theo kích thước video gốc (tránh resize mismatch)
- Trả về `{ x1, y1, x2, y2 }` tỉ lệ với video gốc (0-1 range)

## API Client (`lib/api.ts`)
```typescript
const api = axios.create({ baseURL: '/api' });  // proxy qua Next.js rewrites

uploadVideo(file: File) => POST /api/upload (multipart)
getFrame(videoId: string) => GET /api/frame/{videoId} (blob)
processVideo(videoId: string, region: Region) => POST /api/process
downloadSrt(videoId: string) => GET /api/download/{videoId} (blob → download)
```

## Tailwind Conventions
- `@apply` directives trong CSS file (không dùng utility classes trực tiếp quá nhiều)
- Dark mode: class-based (`dark:` variants)
- Responsive: mobile-first breakpoints
