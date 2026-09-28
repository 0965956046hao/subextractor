import fs from "fs";
import os from "os";
import path from "path";

/** Server-side scan cache (per-channel videos + playlists + per-mix videos).
 *  Lives next to the channels file so scans survive restarts and are shared
 *  by all scan routes. Incremental scans merge fresh items over the cache
 *  (dedupe by aweme_id, newest first, capped). */

const CHANNELS_FILE =
  process.env.CHANNELS_FILE ||
  path.join(os.tmpdir(), "subextractor-channels.json");

const SCANS_FILE =
  process.env.CHANNEL_SCANS_FILE ||
  path.join(path.dirname(CHANNELS_FILE), "subextractor-channel-scans.json");

export const SCAN_CACHE_CAP = 500;

export interface CachedVideoScan {
  scanned_at: number;
  max_time: number;
  videos: any[];
}

export interface CachedMixList {
  scanned_at: number;
  playlists: any[];
}

export interface ScanCache {
  channel_scans: Record<string, CachedVideoScan>;
  mix_lists: Record<string, CachedMixList>;
  mix_scans: Record<string, CachedVideoScan>;
}

function emptyCache(): ScanCache {
  return { channel_scans: {}, mix_lists: {}, mix_scans: {} };
}

export function loadCache(): ScanCache {
  try {
    if (!fs.existsSync(SCANS_FILE)) return emptyCache();
    const raw = JSON.parse(fs.readFileSync(SCANS_FILE, "utf8"));
    return {
      channel_scans: raw?.channel_scans ?? {},
      mix_lists: raw?.mix_lists ?? {},
      mix_scans: raw?.mix_scans ?? {},
    };
  } catch {
    return emptyCache();
  }
}

export function saveCache(cache: ScanCache): void {
  try {
    fs.mkdirSync(path.dirname(SCANS_FILE), { recursive: true });
    fs.writeFileSync(SCANS_FILE, JSON.stringify(cache), "utf8");
  } catch {
    // cache is best-effort — never break a scan
  }
}

/** Merge fresh items over cached ones: dedupe by aweme_id (fresh wins),
 *  newest first, capped. Returns {merged, added} where added counts ids
 *  that were not in the cache. */
export function mergeVideos(
  cached: any[],
  fresh: any[],
  cap: number = SCAN_CACHE_CAP,
): { merged: any[]; added: number } {
  const seen = new Set<string>();
  const merged: any[] = [];
  let added = 0;
  const push = (v: any, isFresh: boolean) => {
    const id = v?.aweme_id ? String(v.aweme_id) : "";
    if (!id || seen.has(id)) return;
    seen.add(id);
    if (isFresh && !cachedIds.has(id)) added += 1;
    merged.push(v);
  };
  const cachedIds = new Set(
    (Array.isArray(cached) ? cached : [])
      .map((v) => (v?.aweme_id ? String(v.aweme_id) : ""))
      .filter(Boolean),
  );
  for (const v of Array.isArray(fresh) ? fresh : []) push(v, true);
  for (const v of Array.isArray(cached) ? cached : []) push(v, false);
  merged.sort((a, b) => (b.create_time || 0) - (a.create_time || 0));
  return { merged: merged.slice(0, cap), added };
}

export function maxCreateTime(videos: any[]): number {
  let max = 0;
  for (const v of videos || []) {
    if (typeof v?.create_time === "number" && v.create_time > max) {
      max = v.create_time;
    }
  }
  return max;
}
