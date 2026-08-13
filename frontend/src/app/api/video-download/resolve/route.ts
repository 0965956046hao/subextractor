import { NextRequest, NextResponse } from "next/server";
import {
  openBrowser,
  closeBrowser,
  isVideoUrl,
  loadCookies,
  saveCookies,
  SOURCE_SELECTOR,
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
  let src: string | null = null;
  let title = "";

  try {
    const page = await handle.browser.newPage();
    page.on("response", (resp) => {
      const u = resp.url();
      if (isVideoUrl(u)) captured.push(u);
    });

    if (!handle.persistent) await page.setUserAgent(USER_AGENT);

    await loadCookies(page);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    try {
      await page.waitForSelector(SOURCE_SELECTOR, { timeout: 30000 });
      src = await page.$eval(SOURCE_SELECTOR, (el) => el.getAttribute("src"));
    } catch {
      if (captured.length === 0) await new Promise((r) => setTimeout(r, 8000));
    }

    await saveCookies(page);

    title = (await page.title()) || "";
  } catch (err) {
    await closeBrowser(handle).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ detail: `Không thể mở link: ${msg}` }, { status: 500 });
  }

  await closeBrowser(handle).catch(() => {});

  if (!src && captured.length) src = captured[0];

  if (!src) {
    return NextResponse.json(
      { detail: "Không tìm thấy URL video. Hãy đăng nhập Douyin rồi thử lại." },
      { status: 400 }
    );
  }

  return NextResponse.json({ url: src, title });
}
