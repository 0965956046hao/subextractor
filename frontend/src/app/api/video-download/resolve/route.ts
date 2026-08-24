import { NextRequest, NextResponse } from "next/server";
import {
  openBrowser,
  closeBrowser,
  isVideoUrl,
  isMp4Url,
  loadCookies,
  saveCookies,
  USER_AGENT,
  classifyTrack,
  type BrowserHandle,
} from "@/lib/douyin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "Invalid JSON body" }, { status: 400 });
  }

  const url = (body.url || "").trim();
  if (!url)
    return NextResponse.json({ detail: "URL is required" }, { status: 400 });

  let handle: BrowserHandle;
  try {
    handle = await openBrowser({ headless: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        detail:
          `Không mở được Chrome: ${msg}. ` +
          "Đảm bảo Google Chrome đã cài, hoặc đang chạy với --remote-debugging-port=9222.",
      },
      { status: 500 },
    );
  }

  const captured: string[] = [];
  let title = "";
  // Gộp luôn việc lấy thumbnail + big_thumbs trong cùng session Chrome này
  // (trước đây phải mở Chrome lần 2 ở /api/video-download/thumbnail).
  let thumbnail: string | null = null;
  let bigThumbs: string[] = [];
  let postCover: string[] = [];
  let resolveDetail: (() => void) | null = null;
  const detailReady = new Promise<void>((resolve) => {
    resolveDetail = resolve;
  });

  try {
    const page = await handle.browser.newPage();

    // Nghe network request NGAY TỪ ĐẦU (không chờ DOM): bắt URL video/audio
    // khi trình duyệt request CDN, trước khi video element được render.
    page.on("request", (request) => {
      const u = request.url();
      if (isVideoUrl(u) || isMp4Url(u)) {
        captured.push(u);
      }
    });

    // Nghe response /aweme/v1/web/aweme/detail/ ngay trên trang video để trích
    // thumbnail (cover_original_scale.url_list, ưu tiên URL lk3s) + big_thumbs.
    page.on("response", async (resp) => {
      const u = resp.url();
      if (!u.includes("/aweme/v1/web/aweme/detail/")) return;
      try {
        const data = await resp.json();
        const aweme = data?.aweme_detail ?? null;
        if (!aweme) return;
        const covers = Array.isArray(
          aweme.video?.cover_original_scale?.url_list,
        )
          ? (aweme.video.cover_original_scale.url_list as string[])
          : [];
        if (covers.length) postCover = covers;
        const thumbs = Array.isArray(aweme.video?.big_thumbs)
          ? (aweme.video.big_thumbs as Array<{ img_urls?: string[] }>)
          : [];
        const thumbUrls = thumbs
          .flatMap((t) => (Array.isArray(t?.img_urls) ? t.img_urls : []))
          .filter((v): v is string => {
            if (typeof v !== "string") return false;
            try {
              const parsed = new URL(v);
              return (
                parsed.protocol === "http:" || parsed.protocol === "https:"
              );
            } catch {
              return false;
            }
          });
        if (thumbUrls.length) bigThumbs = thumbUrls;
        if (covers.length || thumbUrls.length) {
          resolveDetail?.();
        }
      } catch {
        // không parse được body — bỏ qua
      }
    });

    if (!handle.persistent) await page.setUserAgent(USER_AGENT);

    await loadCookies(page);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Chờ một chút cho các request media (video/audio CDN) kịp fire.
    for (let i = 0; i < 100; i++) {
      if (captured.length > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    // Sau khi bắt được media URL, chờ thêm tối đa 15s cho response aweme/detail
    // (thumbnail + big_thumbs) nếu chưa tới — tránh phải mở Chrome lần 2.
    await Promise.race([detailReady, new Promise((r) => setTimeout(r, 15000))]);
    if (postCover.length) {
      thumbnail =
        postCover.find((c) => c.includes("lk3s")) ?? postCover[0];
    }

    await saveCookies(page);

    title = (await page.title()) || "";
  } catch (err) {
    await closeBrowser(handle).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { detail: `Không thể mở link: ${msg}` },
      { status: 500 },
    );
  }

  await closeBrowser(handle).catch(() => {});

  const all = Array.from(new Set(captured));

  if (all.length === 0) {
    return NextResponse.json(
      { detail: "Không tìm thấy URL video. Hãy đăng nhập Douyin rồi thử lại." },
      { status: 400 },
    );
  }

  const audioUrl = all.find((u) => classifyTrack(u) === "audio") ?? null;
  const videoUrl =
    all.find((u) => classifyTrack(u) === "video") ?? all[0] ?? null;

  return NextResponse.json({
    video_url: videoUrl,
    audio_url: audioUrl,
    title,
    thumbnail,
    bigThumbs,
  });
}
