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
  mix_info?: { mix_id?: string; mix_name?: string };
}

interface PlaylistGroup {
  id: string;
  title: string;
  videos: AwemeItem[];
}

interface ScanResult {
  channel_name: string;
  total: number;
  filtered: number;
  videos: AwemeItem[];
  playlists: PlaylistGroup[];
  /** Incremental-cache info. */
  cached?: number;
  added?: number;
  scanned_at?: number;
  from_cache?: boolean;
}

export async function POST(req: NextRequest) {
  let body: { url?: string; since?: number; full?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "Invalid JSON body" }, { status: 400 });
  }

  const url = (body.url || "").trim();
  if (!url)
    return NextResponse.json({ detail: "URL is required" }, { status: 400 });

  const cache = loadCache();
  const prev = cache.channel_scans[url];
  const prevVideos = prev?.videos ?? [];
  // Date filter is display-only. The merge always absorbs every freshly
  // captured video (deep scroll reaches old ones the cache never saw) —
  // filtering by cache max_time here would silently drop them.
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
  const capturedMixLists: Array<Array<{ mix_id: string; mix_name: string }>> = [];
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

    page.on("response", async (resp) => {
      const u = resp.url();
      if (!u.includes("mix")) return;
      try {
        const data = await resp.json();
        const mixList = data?.mix_list ?? [];
        if (Array.isArray(mixList) && mixList.length > 0) {
          capturedMixLists.push(
            mixList
              .filter((m: any) => m?.mix_id)
              .map((m: any) => ({ mix_id: String(m.mix_id), mix_name: String(m.mix_name || m.mix_id) })),
          );
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

    // Deep-scroll the 作品 list: the tab holds hundreds of videos but only
    // loads more while its own scroll container moves (manual refetch of
    // aweme/post is WAF-blocked — verified live, the page's own signed XHRs
    // are the only way). Jump to the bottom each round; stop after 4 stable.
    // NOTE: channel pages scroll an inner `.route-scroll-container` div —
    // window.scrollBy loads nothing.
    if (capturedAwemeLists.length > 0) {
      let stableRounds = 0;
      let prevCount = capturedAwemeLists.flat().length;
      for (let scroll = 0; scroll < 40; scroll++) {
        await page
          .evaluate(() => {
            const el = document.querySelector(
              ".route-scroll-container",
            ) as HTMLElement | null;
            const target = el ?? document.scrollingElement;
            if (target) target.scrollTop = target.scrollHeight;
          })
          .catch(() => {});
        await new Promise((r) => setTimeout(r, 3000));
        const now = capturedAwemeLists.flat().length;
        if (now > prevCount) {
          stableRounds = 0;
          prevCount = now;
        } else {
          stableRounds += 1;
          if (stableRounds >= 4) break;
        }
        if (now >= SCAN_CACHE_CAP) break;
      }
    }

    await saveCookies(page);
    scanComplete = true;
  } catch (err) {
    await closeBrowser(handle).catch(() => {});
    // Resilience: serve the cache when a live scan fails (unioned with
    // collections like the live path).
    if (prevVideos.length > 0) {
      const unioned = [...prevVideos];
      const seenIds = new Set(unioned.map((v) => String(v?.aweme_id || "")));
      const mixIds = new Set(
        (cache.mix_lists[url]?.playlists || []).map((p) => String(p.id)),
      );
      for (const [mid, ms] of Object.entries(cache.mix_scans)) {
        if (!mixIds.has(mid)) continue;
        for (const v of ms?.videos || []) {
          const aid = String(v?.aweme_id || "");
          if (aid && !seenIds.has(aid)) {
            seenIds.add(aid);
            unioned.push(v);
          }
        }
      }
      const groups = buildGroups(unioned, new Map());
      return NextResponse.json({
        channel_name: "",
        total: unioned.length,
        filtered: unioned.length,
        videos: unioned,
        playlists: Array.from(groups.values()),
        cached: unioned.length,
        added: 0,
        scanned_at: prev?.scanned_at ?? 0,
        from_cache: true,
      });
    }
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

  // Date filter is display-only (the Lọc được tag). Every captured video
  // joins the merge below regardless of age.
  const filtered = sinceTimestamp > 0
    ? allVideos.filter((v) => v.create_time > sinceTimestamp)
    : allVideos;

  // Sort by create_time descending
  allVideos.sort((a, b) => b.create_time - a.create_time);

  const mixIdToName = new Map<string, string>();
  for (const list of capturedMixLists) {
    for (const m of list) {
      if (!mixIdToName.has(m.mix_id)) mixIdToName.set(m.mix_id, m.mix_name);
    }
  }

  // Merge fresh items over the cache and persist (ALL captured videos —
  // never the date-filtered subset, or deep-scroll discoveries get lost).
  const { merged, added } = mergeVideos(prevVideos, allVideos);

  // Union with this channel's collections: date-scan only reaches recent
  // videos, older ones live inside mix_scans (phase-2). Without this the
  // channel total is absurdly smaller than a single collection.
  const mixIds = new Set(
    (cache.mix_lists[url]?.playlists || []).map((p) => String(p.id)),
  );
  if (mixIds.size > 0) {
    const seen = new Set(merged.map((v) => String(v?.aweme_id || "")));
    for (const [mid, ms] of Object.entries(cache.mix_scans)) {
      if (!mixIds.has(mid)) continue;
      for (const v of ms?.videos || []) {
        const aid = String(v?.aweme_id || "");
        if (aid && !seen.has(aid)) {
          seen.add(aid);
          merged.push(v);
        }
      }
    }
    merged.sort((a, b) => (b.create_time || 0) - (a.create_time || 0));
  }
  if (merged.length > SCAN_CACHE_CAP) merged.length = SCAN_CACHE_CAP;
  const nowSec = Math.floor(Date.now() / 1000);

  // Membership lookup from per-collection caches (title known at save time).
  const memberOf = new Map<string, { id: string; title: string }>();
  for (const [mixId, ms] of Object.entries(cache.mix_scans)) {
    const title = ms?.title || mixId;
    for (const v of ms?.videos || []) {
      const aid = v?.aweme_id ? String(v.aweme_id) : "";
      if (aid && !memberOf.has(aid)) memberOf.set(aid, { id: mixId, title });
    }
  }

  const groups = buildGroups(merged, mixIdToName, memberOf);

  cache.channel_scans[url] = {
    scanned_at: nowSec,
    max_time: maxCreateTime(merged),
    videos: merged,
    playlists: Array.from(groups.values()).map((g) => ({
      id: g.id,
      title: g.title,
      ids: g.videos.map((v) => String(v.aweme_id)),
    })),
  };
  saveCache(cache);

  const result: ScanResult = {
    channel_name: channelName,
    total: allVideos.length,
    filtered: filtered.length,
    videos: merged,
    playlists: Array.from(groups.values()),
    cached: prevVideos.length,
    added,
    scanned_at: nowSec,
    from_cache: false,
  };

  return NextResponse.json(result);
}

function buildGroups(
  videos: AwemeItem[],
  mixIdToName: Map<string, string>,
  memberOf?: Map<string, { id: string; title: string }>,
): Map<string, PlaylistGroup> {
  const groups = new Map<string, PlaylistGroup>();
  const ensure = (id: string, title: string) => {
    if (!groups.has(id)) groups.set(id, { id, title, videos: [] });
    return groups.get(id)!;
  };
  for (const v of videos) {
    const mid = v.mix_info?.mix_id ? String(v.mix_info.mix_id) : "";
    if (mid) {
      ensure(mid, v.mix_info?.mix_name || mixIdToName.get(mid) || mid).videos.push(v);
      continue;
    }
    const m = memberOf?.get(String(v.aweme_id));
    if (m) ensure(m.id, m.title).videos.push(v);
  }
  return groups;
}
