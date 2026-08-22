import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ detail: "Missing url param" }, { status: 400 });
  }

  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://www.douyin.com/",
      },
    });

    if (!resp.ok) {
      return NextResponse.json(
        { detail: `Upstream error: ${resp.status}` },
        { status: resp.status },
      );
    }

    const contentType = resp.headers.get("content-type") || "video/mp4";
    const contentLength = resp.headers.get("content-length");

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    };
    if (contentLength) {
      headers["Content-Length"] = contentLength;
    }

    return new NextResponse(resp.body, {
      status: 200,
      headers,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ detail: msg }, { status: 500 });
  }
}
