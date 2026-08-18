import { NextResponse } from "next/server";
import {
  openChatGptBrowser,
  closeBrowser,
  CHATGPT_URL,
} from "@/lib/chatgpt";
import type { BrowserHandle } from "@/lib/douyin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  let handle: BrowserHandle;
  try {
    handle = await openChatGptBrowser();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        detail:
          `Không mở được Chrome: ${msg}. ` +
          "Đảm bảo Google Chrome đã cài.",
      },
      { status: 500 }
    );
  }

  try {
    const page = await handle.browser.newPage();
    await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded" });
    await closeBrowser(handle).catch(() => {});
  } catch (err) {
    await closeBrowser(handle).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ detail: `Không mở được ChatGPT: ${msg}` }, { status: 500 });
  }

  return NextResponse.json({ status: "ok", mode: handle.persistent ? "connect" : "launch" });
}
