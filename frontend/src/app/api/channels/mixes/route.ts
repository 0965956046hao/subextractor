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
} from "@/lib/channel-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface MixEntry {
  id: string;
  title: string;
  cover?: string;
  video_count?: number;
}

interface MixesResult {
  channel_name: string;
  playlists: MixEntry[];
  /** API paths seen during scan — debug aid when playlists come back empty. */
  debug_apis: string[];
  scanned_at?: number;
  from_cache?: boolean;
}

/** Phase 1 of full-channel scan: list the channel's collections (合集) only.
 *  Lightweight — no deep scroll, no date filter. Phase 2 (mix-videos) fetches
 *  videos per collection on demand. */
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

  // Channel identity for attributing API responses (see handler below).
  const secUid =
    url.match(/\/user\/([^/?#]+)/)?.[1] || "";

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

  const capturedMixLists: MixEntry[][] = [];
  const seenApis = new Set<string>();
  let channelName = "";
  /** First channel-scoped mix/list URL — reused for cursor pagination. */
  let seedListUrl = "";

  const pickCover = (m: any): string | undefined => {
    const lists = [
      m?.cover_url?.url_list,
      m?.horizontal_cover_url?.url_list,
      m?.mix_cover?.url_list,
      m?.cover?.url_list,
      m?.mix_pic?.url_list,
    ];
    for (const l of lists) {
      if (Array.isArray(l) && l.length > 0 && typeof l[0] === "string") return l[0];
    }
    if (typeof m?.cover_url === "string" && m.cover_url) return m.cover_url;
    return undefined;
  };

  const pickCount = (m: any): number | undefined => {
    const cands = [
      m?.video_count,
      m?.count,
      m?.statis?.updated_to_episode,
      m?.statis?.current_episode,
      m?.stats?.updated_to_episode,
      m?.stats?.total_episode_count,
      m?.stats?.episode_count,
    ];
    for (const c of cands) {
      if (typeof c === "number") return c;
    }
    return undefined;
  };

  const pickId = (m: any): string =>
    m?.mix_id ? String(m.mix_id) : m?.series_id ? String(m.series_id) : "";

  const pickTitle = (m: any, fallback: string): string =>
    String(m?.mix_name || m?.series_name || m?.name || fallback);

  const pushMixList = (mixList: any) => {
    if (!Array.isArray(mixList) || mixList.length === 0) return;
    capturedMixLists.push(
      mixList
        .map((m: any): MixEntry | null => {
          const id = pickId(m);
          return id
            ? {
                id,
                title: pickTitle(m, id),
                cover: pickCover(m),
                video_count: pickCount(m),
              }
            : null;
        })
        .filter((x): x is MixEntry => !!x),
    );
  };

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
      // ONLY channel-scoped sources: mix/list + series/list whose sec_user_id
      // matches the visited channel (fire on 合集 tab click). Page-load
      // prefetches WITHOUT sec_user_id are session-scoped and misattribute
      // other channels' data — verified live: they must be discarded.
      if (!u.includes("/mix/list") && !u.includes("/series/list")) return;
      let uid = "";
      try {
        uid = new URL(u).searchParams.get("sec_user_id") || "";
      } catch {
        return;
      }
      if (!uid || (secUid && uid !== secUid)) return;
      try {
        const data = await resp.json();
        pushMixList(data?.mix_infos ?? data?.series_infos ?? data?.mix_list);
        if (
          !seedListUrl &&
          (data?.mix_infos?.length ||
            data?.series_infos?.length ||
            data?.mix_list?.length)
        ) {
          seedListUrl = u;
        }
      } catch {
        // non-JSON response, skip
      }
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    // The 合集 tab loads the channel's collections on click. No such tab =
    // the channel has no collections → return empty (fast, correct).
    // Poll for the tabs first: they render after hydration, clicking too
    // early misses and falls back to cover-less DOM links.
    let hasMixTab = false;
    for (let i = 0; i < 20; i++) {
      hasMixTab = await page
        .evaluate(() => {
          const tabs = Array.from(document.querySelectorAll(".semi-tabs-tab"));
          const hit = tabs.find((el) => (el.textContent || "").includes("合集"));
          if (hit) {
            (hit as HTMLElement).click();
            return true;
          }
          return false;
        })
        .catch(() => false);
      if (hasMixTab || capturedMixLists.length > 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (hasMixTab) {
      // Wait for the tab's mix/list API (up to 15s).
      for (let i = 0; i < 30; i++) {
        if (capturedMixLists.length > 0) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      // Cursor pagination for channels with many collections (same-session
      // refetch proven to work for series-style list APIs).
      if (seedListUrl) {
        try {
          for (let round = 0; round < 10; round++) {
            const pageData = await page
              .evaluate(async (base: string, skip: number) => {
                const u = new URL(base);
                u.searchParams.set("cursor", String(skip));
                const r = await fetch(u.toString());
                const d = await r.json();
                return {
                  list: (Array.isArray(d?.mix_infos)
                    ? d.mix_infos
                    : Array.isArray(d?.series_infos)
                      ? d.series_infos
                      : Array.isArray(d?.mix_list)
                        ? d.mix_list
                        : []) as any[],
                  has_more: !!d?.has_more,
                };
              }, seedListUrl, capturedMixLists.flat().length)
              .catch(() => null);
            if (!pageData || pageData.list.length === 0) break;
            const before = capturedMixLists.flat().length;
            pushMixList(pageData.list);
            if (capturedMixLists.flat().length <= before) break;
            if (!pageData.has_more) break;
          }
        } catch {
          // keep whatever the tab click captured
        }
      }
    }

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

    // DOM fallback: direct /collection/ links on the channel page.
    try {
      const domMixes = await page.evaluate(() => {
        const out: Array<{ id: string; title: string }> = [];
        const seen = new Set<string>();
        document.querySelectorAll('a[href*="/collection/"]').forEach((a) => {
          const href = (a as HTMLAnchorElement).href || "";
          const m = href.match(/\/collection\/(\d+)/);
          if (m && !seen.has(m[1])) {
            seen.add(m[1]);
            out.push({
              id: m[1],
              title: a.textContent?.trim().slice(0, 80) || m[1],
            });
          }
        });
        return out;
      });
      if (domMixes.length > 0) {
        capturedMixLists.push(
          domMixes.map((d) => ({ id: d.id, title: d.title })),
        );
      }
    } catch {
      // ignore
    }

    await saveCookies(page);
  } catch (err) {
    await closeBrowser(handle).catch(() => {});
    // Resilience: serve cached playlists when a live scan fails.
    const cached = loadCache().mix_lists[url];
    if (cached && cached.playlists.length > 0) {
      return NextResponse.json({
        channel_name: "",
        playlists: cached.playlists,
        debug_apis: [],
        scanned_at: cached.scanned_at,
        from_cache: true,
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { detail: `Quét danh sách phát thất bại: ${msg}` },
      { status: 500 },
    );
  }

  await closeBrowser(handle).catch(() => {});

  // Merge: API results win over DOM fallback (richer names/covers).
  const merged = new Map<string, MixEntry>();
  for (const list of capturedMixLists) {
    for (const m of list) {
      const prev = merged.get(m.id);
      if (!prev) {
        merged.set(m.id, m);
      } else if (prev.title === prev.id && m.title !== m.id) {
        merged.set(m.id, { ...m, cover: m.cover ?? prev.cover });
      }
    }
  }

  const playlists = Array.from(merged.values());
  const nowSec = Math.floor(Date.now() / 1000);
  if (playlists.length > 0) {
    const cache = loadCache();
    cache.mix_lists[url] = { scanned_at: nowSec, playlists };
    saveCache(cache);
  }

  const result: MixesResult = {
    channel_name: channelName,
    playlists,
    debug_apis: Array.from(seenApis),
    scanned_at: nowSec,
    from_cache: false,
  };

  return NextResponse.json(result);
}
