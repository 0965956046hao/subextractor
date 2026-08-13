import { NextResponse } from "next/server";
import {
  openBrowser,
  disconnectBrowser,
  loadCookies,
  saveCookies,
  type BrowserHandle,
} from "@/lib/douyin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  let handle: BrowserHandle;
  try {
    handle = await openBrowser({ headless: false });
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

  try {
    const page = await handle.browser.newPage();
    await loadCookies(page);
    await page.goto("https://www.douyin.com", { waitUntil: "domcontentloaded" });
    await saveCookies(page);
  } catch (err) {
    await disconnectBrowser(handle).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ detail: `Không mở được Douyin: ${msg}` }, { status: 500 });
  }

  await disconnectBrowser(handle).catch(() => {});
  return NextResponse.json({ status: "ok", mode: handle.persistent ? "connect" : "launch" });
}
