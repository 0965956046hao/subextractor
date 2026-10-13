import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Cho phép request import chạy nền tới 5 phút (download 17MB + thumbs).
export const maxDuration = 300;

const BACKEND = process.env.BACKEND_URL || "http://localhost:8002";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "Invalid JSON body" }, { status: 400 });
  }
  // Forward query string (?sync=1) nếu có.
  const qs = req.nextUrl.search || "";
  try {
    const resp = await fetch(`${BACKEND}/api/import-video${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    return NextResponse.json(data, { status: resp.status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        detail:
          `Không kết nối được backend import-video (${msg}). ` +
          "Backend có thể đang restart hoặc bận tải video — thử lại sau vài giây, " +
          "không bấm retry liên tục để tránh tạo video trùng.",
      },
      { status: 502 },
    );
  }
}
