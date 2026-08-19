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

  try {
    const page = await handle.browser.newPage();
    if (!handle.persistent) await page.setUserAgent(USER_AGENT);

    await loadCookies(page);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Lấy userId từ thẻ <a href="/user/{userId}"> và videoId từ URL
    const userId = await page.evaluate(() => {
      const a = document.querySelector('a[href*="/user/"]');
      const href = a ? a.getAttribute("href") || "" : "";
      const m = href.match(/\/user\/([^/?]+)/);
      return m ? m[1] : null;
    });
    const videoId = await page.evaluate(() => {
      const m = window.location.href.match(/\/video\/(\d+)/);
      return m ? m[1] : null;
    });

    if (userId && videoId) {
      await page.goto(
        `https://www.douyin.com/user/${userId}?modal_id=${videoId}`,
        { waitUntil: "domcontentloaded", timeout: 45000 },
      );
      await new Promise((r) => setTimeout(r, 1500));

      // Nếu có dialog "我知道了" thì click để đóng, không có thì chạy bình thường
      try {
        const clicked = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll("button"));
          const target = buttons.find((b) =>
            (b.textContent || "").includes("我知道了"),
          );
          if (target) {
            (target as HTMLButtonElement).click();
            return true;
          }
          return false;
        });
        if (clicked) await new Promise((r) => setTimeout(r, 800));
      } catch {
        // ignore
      }

      try {
        await page.waitForSelector(
          'div.account-name.userAccountTextHover[data-e2e="feed-video-nickname"]',
          { timeout: 10000 },
        );
        await page.click(
          'div.account-name.userAccountTextHover[data-e2e="feed-video-nickname"]',
        );
        await new Promise((r) => setTimeout(r, 10000));
      } catch {
        // account-name có thể không cần click
      }

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

  return NextResponse.json({ thumbnail });
}
