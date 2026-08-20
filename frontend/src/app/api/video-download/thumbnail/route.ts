import { NextRequest, NextResponse } from "next/server";
import {
  openBrowser,
  closeBrowser,
  loadCookies,
  USER_AGENT,
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
      { detail: `Không mở được Chrome: ${msg}` },
      { status: 500 },
    );
  }

  let thumbnail: string | null = null;
  let bigThumbs: string[] = [];

  try {
    const page = await handle.browser.newPage();
    if (!handle.persistent) await page.setUserAgent(USER_AGENT);

    await loadCookies(page);

    // Bắt response của API /aweme/v1/web/aweme/detail/ ngay trên trang video:
    // data.aweme_detail.video.cover.url_list → thumbnail (ưu tiên URL có lk3s),
    // data.aweme_detail.video.big_thumbs[].img_urls → bigThumbs (chỉ giữ URL hợp lệ).
    let postCover: string[] = [];
    let detailResolved = false;
    let resolveDetail: (() => void) | null = null;
    const detailReady = new Promise<void>((resolve) => {
      resolveDetail = resolve;
    });

    page.on("response", async (resp) => {
      const u = resp.url();
      if (!u.includes("/aweme/v1/web/aweme/detail/")) return;
      try {
        const data = await resp.json();
        const aweme = data?.aweme_detail ?? data?.aweme ?? null;
        if (!aweme) return;
        const covers = Array.isArray(aweme.video?.cover?.url_list)
          ? (aweme.video.cover.url_list as string[])
          : [];
        if (covers.length) postCover = covers;
        const thumbs = Array.isArray(aweme.video?.big_thumbs)
          ? (aweme.video.big_thumbs as Array<{ img_urls?: string[] }>)
          : [];
        const thumbUrls = thumbs
          .flatMap((t) => (Array.isArray(t?.img_urls) ? t.img_urls : []))
          .filter((u): u is string => {
            if (typeof u !== "string") return false;
            try {
              const parsed = new URL(u);
              return (
                parsed.protocol === "http:" || parsed.protocol === "https:"
              );
            } catch {
              return false;
            }
          });
        if (thumbUrls.length) bigThumbs = thumbUrls;
        if (covers.length || thumbUrls.length) {
          detailResolved = true;
          resolveDetail?.();
        }
      } catch {
        // không parse được body — bỏ qua
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Đợi response detail về (timeout 15s). Trang có thể gọi detail trước khi
    // goto xong, listener đã đăng ký sẵn nên vẫn bắt được.
    await Promise.race([
      detailReady,
      new Promise((r) => setTimeout(r, 15000)),
    ]);

    if (postCover.length) {
      thumbnail = postCover.find((c) => c.includes("lk3s")) ?? postCover[0];
    }

    // Fallback: quét DOM nếu chưa lấy được thumbnail từ API
    if (!thumbnail) {
      const extractThumbnail = () =>
        page.evaluate(() => {
          const decode = (s: string) => s.replace(/&amp;/g, "&");
          const item = document.querySelector("div.video-playing-item");
          if (!item) return null;
          const el = item.querySelector("img[src]");
          return el ? decode(el.getAttribute("src") || "") : null;
        });

      thumbnail = await extractThumbnail();

      // Nếu chưa lấy được thì chờ thêm 10s và retry 1 lần nữa
      if (!thumbnail) {
        await new Promise((r) => setTimeout(r, 10000));
        thumbnail = await extractThumbnail();
      }
    }
  } catch (err) {
    await closeBrowser(handle).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { detail: `Không thể mở link: ${msg}` },
      { status: 500 },
    );
  }

  await closeBrowser(handle).catch(() => {});

  return NextResponse.json({ thumbnail, bigThumbs });
}