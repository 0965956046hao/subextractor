import { NextRequest, NextResponse } from "next/server";
import {
  openBrowser,
  closeBrowser,
  loadCookies,
  saveCookies,
  USER_AGENT,
  type BrowserHandle,
} from "@/lib/douyin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AwemeItem {
  aweme_id: string;
  desc: string;
  create_time: number;
  share_url?: string;
  share_link_desc?: string;
  author?: { nickname?: string; uid?: string };
  video?: {
    cover?: { url_list?: string[] };
    play_addr?: { url_list?: string[] };
    duration?: number;
  };
  statistics?: {
    play_count?: number;
    digg_count?: number;
    comment_count?: number;
    share_count?: number;
  };
}

interface ScanResult {
  channel_name: string;
  total: number;
  filtered: number;
  videos: AwemeItem[];
}

export async function POST(req: NextRequest) {
  let body: { url?: string; since?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "Invalid JSON body" }, { status: 400 });
  }

  const url = (body.url || "").trim();
  if (!url)
    return NextResponse.json({ detail: "URL is required" }, { status: 400 });

  const sinceTimestamp = body.since ?? 0;

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

  const capturedAwemeLists: AwemeItem[][] = [];
  let channelName = "";
  let scanComplete = false;

  try {
    const page = await handle.browser.newPage();
    if (!handle.persistent) await page.setUserAgent(USER_AGENT);
    await loadCookies(page);

    page.on("response", async (resp) => {
      const u = resp.url();
      if (!u.includes("/aweme/v1/web/aweme/post/")) return;
      try {
        const data = await resp.json();
        const awemeList: AwemeItem[] = data?.aweme_list ?? [];
        if (awemeList.length > 0) {
          capturedAwemeLists.push(awemeList);
        }
      } catch {
        // non-JSON response, skip
      }
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    // Wait for the aweme post API to fire (up to 20s)
    for (let i = 0; i < 40; i++) {
      if (capturedAwemeLists.length > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    // Try to get channel name from page
    try {
      channelName = await page.evaluate(() => {
        const nameEl = document.querySelector(
          '[data-e2e="user-info"] .j5WZzJdp, .e6wsjNLL span, .QXuHv3I3',
        );
        return nameEl?.textContent?.trim() || "";
      });
    } catch {
      // ignore
    }

    // Try scrolling to load more if needed
    if (capturedAwemeLists.length > 0) {
      for (let scroll = 0; scroll < 3; scroll++) {
        const prevCount = capturedAwemeLists.flat().length;
        await page.evaluate(() => window.scrollBy(0, 1000));
        await new Promise((r) => setTimeout(r, 2000));
        if (capturedAwemeLists.flat().length > prevCount) continue;
        break;
      }
    }

    await saveCookies(page);
    scanComplete = true;
  } catch (err) {
    await closeBrowser(handle).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { detail: `Quét kênh thất bại: ${msg}` },
      { status: 500 },
    );
  }

  await closeBrowser(handle).catch(() => {});

  // Merge and deduplicate all captured aweme_list responses
  const allItems = new Map<string, AwemeItem>();
  for (const list of capturedAwemeLists) {
    for (const item of list) {
      if (item.aweme_id && !allItems.has(item.aweme_id)) {
        allItems.set(item.aweme_id, item);
      }
    }
  }

  const allVideos = Array.from(allItems.values());

  // Filter by create_time > sinceTimestamp
  const filtered = sinceTimestamp > 0
    ? allVideos.filter((v) => v.create_time > sinceTimestamp)
    : allVideos;

  // Sort by create_time descending
  filtered.sort((a, b) => b.create_time - a.create_time);

  const result: ScanResult = {
    channel_name: channelName,
    total: allVideos.length,
    filtered: filtered.length,
    videos: filtered,
  };

  return NextResponse.json(result);
}
