import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BACKEND = process.env.BACKEND_URL || "http://localhost:8002";

export async function GET(
  _req: NextRequest,
  { params }: { params: { jobId: string } },
) {
  try {
    const resp = await fetch(
      `${BACKEND}/api/import-video/${encodeURIComponent(params.jobId)}`,
      { cache: "no-store" },
    );
    const data = await resp.json().catch(() => ({}));
    return NextResponse.json(data, { status: resp.status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { detail: `Không kết nối được backend (${msg})` },
      { status: 502 },
    );
  }
}
