import { NextRequest, NextResponse } from "next/server";
import {
  openBrowser,
  closeBrowser,
  loadCookies,
  saveCookies,
  USER_AGENT,
  type BrowserHandle,
} from "@/lib/douyin";
import {
  loadCache,
  saveCache,
  mergeVideos,
  maxCreateTime,
  SCAN_CACHE_CAP,
} from "@/lib/channel-cache";

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

const MAX_VIDEOS = 200;
const MAX_SCROLLS = 25;

/** Phase 2 of full-channel scan: fetch all videos inside one collection.
 *  Incremental default: cursor pagination stops at the first page overlapping
 *  the cache (APIs return newest first). full=true refetches from scratch. */
export async function POST(req: NextRequest) {
  let body: { mix_id?: string; full?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "Invalid JSON body" }, { status: 400 });
  }

  const mixId = (body.mix_id || "").trim();
  if (!mixId)
    return NextResponse.json({ detail: "mix_id is required" }, { status: 400 });

  const cache = loadCache();
  const prev = cache.mix_scans[mixId];
  const prevVideos = prev?.videos ?? [];
  const prevIds = new Set(prevVideos.map((v) => String(v?.aweme_id || "")));
  const incremental = !body.full && prevIds.size > 0;

  const url = `https://www.douyin.com/collection/${mixId}`;

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

  // Primary bucket: mix/collection/series list APIs. Fallback bucket: any
  // aweme_list — used only when the primary bucket stays empty (Douyin
  // renamed the API).
  const primaryLists: AwemeItem[][] = [];
  const fallbackLists: AwemeItem[][] = [];
  const seenApis = new Set<string>();
  let playlistTitle = "";
  /** First list-API URL seen — reused for cursor pagination below. */
  let seedListUrl = "";

  const countAll = () =>
    new Map(
      [...primaryLists, ...fallbackLists]
        .flat()
        .filter((v) => v?.aweme_id)
        .map((v) => [v.aweme_id, v]),
    ).size;

  try {
    const page = await handle.browser.newPage();
    if (!handle.persistent) await page.setUserAgent(USER_AGENT);
    await loadCookies(page);

    page.on("response", async (resp) => {
      const u = resp.url();
      if (!u.includes("/aweme/")) return;
      try {
        const path = new URL(u).pathname;
        if (seenApis.size < 50) seenApis.add(path);
      } catch {
        // ignore malformed URL
      }
      try {
        const data = await resp.json();
        const awemeList: AwemeItem[] = data?.aweme_list ?? [];
        if (!Array.isArray(awemeList) || awemeList.length === 0) return;
        if (
          u.includes("mix") ||
          u.includes("collect") ||
          u.includes("series")
        ) {
          primaryLists.push(awemeList);
          if (!seedListUrl) seedListUrl = u;
        } else {
          fallbackLists.push(awemeList);
        }
      } catch {
        // non-JSON response, skip
      }
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    // Wait for the first video list (up to 20s).
    for (let i = 0; i < 40; i++) {
      if (countAll() > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    // Scroll until the list stops growing (twice in a row) or caps hit.
    // NOTE: collection pages scroll an inner `.route-scroll-container` div —
    // the document itself has no scrollbar, so window.scrollBy loads nothing.
    let stableRounds = 0;
    let prevCount = countAll();
    for (let scroll = 0; scroll < MAX_SCROLLS; scroll++) {
      if (countAll() >= MAX_VIDEOS) break;
      const pos = await page
        .evaluate(() => {
          const el = document.querySelector(
            ".route-scroll-container",
          ) as HTMLElement | null;
          const target = el ?? document.scrollingElement;
          if (!target) return null;
          target.scrollTop += 1500;
          return {
            top: target.scrollTop,
            height: target.scrollHeight,
            client: target.clientHeight,
          };
        })
        .catch(() => null);
      await new Promise((r) => setTimeout(r, 2000));
      const now = countAll();
      if (now > prevCount) {
        stableRounds = 0;
        prevCount = now;
      } else {
        stableRounds += 1;
        // Bottom reached and nothing new → done.
        if (stableRounds >= 2) break;
        if (pos && pos.top + pos.client >= pos.height - 50 && stableRounds >= 1)
          break;
      }
    }

    try {
      playlistTitle = await page.evaluate(
        () => document.title.replace(/\s*-\s*抖音.*$/, "").trim(),
      );
    } catch {
      // ignore
    }

    // Cursor pagination: series-style APIs (series/aweme, mix/aweme) page by
    // `cursor` but the collection UI only auto-loads the first segment(s) —
    // verified live that refetching the captured list URL with an increasing
    // cursor returns subsequent pages (same session cookies, no re-sign).
    // Incremental mode stops at the first page overlapping the cache.
    if (seedListUrl) {
      try {
        let cursor = 0;
        for (let round = 0; round < 30; round++) {
          const pageData = await page
            .evaluate(
              async (base: string, cur: number) => {
                const u = new URL(base);
                u.searchParams.set("cursor", String(cur));
                const r = await fetch(u.toString());
                const d = await r.json();
                return {
                  list: (Array.isArray(d?.aweme_list) ? d.aweme_list : []) as AwemeItem[],
                  has_more: !!d?.has_more,
                };
              },
              seedListUrl,
              cursor,
            )
            .catch(() => null);
          if (!pageData || pageData.list.length === 0) break;
          primaryLists.push(pageData.list);
          cursor += pageData.list.length;
          if (
            incremental &&
            pageData.list.some((v) => prevIds.has(String(v?.aweme_id || "")))
          ) {
            break; // reached already-cached videos — older pages overlap
          }
          if (!pageData.has_more) break;
          if (primaryLists.flat().length >= SCAN_CACHE_CAP) break;
        }
      } catch {
        // pagination failed — keep whatever the scroll phase captured
      }
    }

    await saveCookies(page);
  } catch (err) {
    await closeBrowser(handle).catch(() => {});
    // Resilience: serve the cache when a live scan fails.
    if (prevVideos.length > 0) {
      return NextResponse.json({
        playlist_title: "",
        total: prevVideos.length,
        videos: prevVideos,
        debug_apis: [],
        from_fallback: false,
        cached: prevVideos.length,
        added: 0,
        scanned_at: prev?.scanned_at ?? 0,
        from_cache: true,
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { detail: `Quét video trong bộ thất bại: ${msg}` },
      { status: 500 },
    );
  }

  await closeBrowser(handle).catch(() => {});

  const source = primaryLists.flat().length > 0 ? primaryLists : fallbackLists;
  const allItems = new Map<string, AwemeItem>();
  for (const list of source) {
    for (const item of list) {
      if (item?.aweme_id && !allItems.has(item.aweme_id)) {
        allItems.set(item.aweme_id, item);
      }
    }
  }

  const fresh = Array.from(allItems.values()).slice(0, SCAN_CACHE_CAP);
  const { merged, added } = mergeVideos(prevVideos, fresh);
  const nowSec = Math.floor(Date.now() / 1000);
  cache.mix_scans[mixId] = {
    scanned_at: nowSec,
    max_time: maxCreateTime(merged),
    videos: merged,
  };
  saveCache(cache);

  const videos = merged
    .sort((a, b) => (b.create_time || 0) - (a.create_time || 0))
    // Tag the known collection so the batch UI groups them (same-collection
    // → shared preset, no popup), even if items lack embedded mix_info.
    .map((v) => ({
      ...v,
      mix_info: {
        mix_id: mixId,
        mix_name: playlistTitle || (v as any)?.mix_info?.mix_name || mixId,
      },
    }));

  return NextResponse.json({
    playlist_title: playlistTitle,
    total: videos.length,
    videos,
    debug_apis: Array.from(seenApis),
    from_fallback: primaryLists.flat().length === 0,
    cached: prevVideos.length,
    added,
    scanned_at: nowSec,
    from_cache: false,
  });
}
