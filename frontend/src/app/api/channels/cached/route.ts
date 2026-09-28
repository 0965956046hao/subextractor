import { NextRequest, NextResponse } from "next/server";
import { loadCache } from "@/lib/channel-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read cached scan data for a channel (no browser, instant).
 *  Used to restore the last results when clicking a channel name.
 *  With ?mix_id=, returns that collection's cached videos instead. */
export async function GET(req: NextRequest) {
  const params = new URL(req.url).searchParams;
  const url = params.get("url")?.trim() || "";
  const mixId = params.get("mix_id")?.trim() || "";
  if (!url && !mixId)
    return NextResponse.json(
      { detail: "url or mix_id is required" },
      { status: 400 },
    );

  const cache = loadCache();
  if (mixId) {
    return NextResponse.json({ mix_scan: cache.mix_scans[mixId] ?? null });
  }
  return NextResponse.json({
    scan: cache.channel_scans[url] ?? null,
    mixes: cache.mix_lists[url] ?? null,
  });
}
