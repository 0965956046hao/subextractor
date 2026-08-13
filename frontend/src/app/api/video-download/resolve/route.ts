import { NextRequest, NextResponse } from "next/server";
import {
  openBrowser,
  closeBrowser,
  isMp4Url,
  loadCookies,
  saveCookies,
  SOURCE_SELECTORS,
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
  if (!url) return NextResponse.json({ detail: "URL is required" }, { status: 400 });

  let handle: BrowserHandle;
  try {
    handle = await openBrowser();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        detail:
          `Không mở được Chrome: ${msg}. ` +
          "Đảm bảo Google Chrome đã cài, hoặc đang chạy với --remote-debugging-port=9222.",
      },
      { status: 500 }
    );
  }

  const captured: string[] = [];
  let srcs: string[] = [];
  let title = "";

  try {
    const page = await handle.browser.newPage();
    page.on("response", (resp) => {
      const u = resp.url();
      if (isMp4Url(u)) captured.push(u);
    });

    if (!handle.persistent) await page.setUserAgent(USER_AGENT);

    await loadCookies(page);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    srcs = await page.evaluate(async (selectors: string[]) => {
      const selector = selectors.join(", ");
      const isMp4 = (v: string) =>
        /^https?:\/\//.test(v) &&
        /\.mp4(\?|$)|video_mp4|mime_type=video_mp4/i.test(v);

      const collect = (): string[] => {
        const out: string[] = [];
        document.querySelectorAll<HTMLElement>(selector).forEach((el) => {
          const s = el.getAttribute("src");
          if (s && isMp4(s)) out.push(s);
        });
        return Array.from(new Set(out));
      };

      const first = collect();
      if (first.length) return first;

      return await new Promise<string[]>((resolve) => {
        let interval: ReturnType<typeof setInterval>;
        let timer: ReturnType<typeof setTimeout>;
        let observer: MutationObserver;
        let settled = false;

        const done = (vals: string[]) => {
          if (settled) return;
          settled = true;
          clearInterval(interval);
          clearTimeout(timer);
          observer.disconnect();
          resolve(vals);
        };

        const check = () => {
          const vals = collect();
          if (vals.length) done(vals);
        };

        observer = new MutationObserver(check);
        const root =
          document.querySelector("xg-video-container") ?? document.body;
        observer.observe(root, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["src"],
        });

        interval = setInterval(check, 200);
        timer = setTimeout(() => done([]), 30000);
      });
    }, SOURCE_SELECTORS);

    await saveCookies(page);

    title = (await page.title()) || "";
  } catch (err) {
    await closeBrowser(handle).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ detail: `Không thể mở link: ${msg}` }, { status: 500 });
  }

  await closeBrowser(handle).catch(() => {});

  const all = Array.from(new Set([...srcs, ...captured]));

  if (all.length === 0) {
    return NextResponse.json(
      { detail: "Không tìm thấy URL video. Hãy đăng nhập Douyin rồi thử lại." },
      { status: 400 }
    );
  }

  const audioUrl =
    all.find((u) => classifyTrack(u) === "audio") ?? null;
  const videoUrl =
    all.find((u) => classifyTrack(u) === "video") ?? all[0] ?? null;

  return NextResponse.json({
    urls: all,
    video_url: videoUrl,
    audio_url: audioUrl,
    title,
  });
}
