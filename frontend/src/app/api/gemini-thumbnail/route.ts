import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";
import { USER_AGENT } from "@/lib/douyin";
import {
  openGeminiBrowser,
  closeGeminiBrowser,
  isGeminiLoggedIn,
  attachGeminiImage,
  submitGeminiPrompt,
  extractGeminiImage,
  GEMINI_URL,
} from "@/lib/gemini";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const videoId = body?.video_id?.trim();
  if (!videoId)
    return NextResponse.json({ detail: "video_id required" }, { status: 400 });
  const extraInstructions = (body?.extra_instructions || "").trim();

  // 1. Same prompt as the fal.ai flow (context + title) + source thumbnail URL.
  let prompt: string;
  let thumbUrl: string;
  try {
    const r = await fetch(`${BACKEND_URL}/api/thumbnail/${videoId}/prompt`);
    if (!r.ok) throw new Error(`prompt fetch failed: ${r.status}`);
    const d = await r.json();
    prompt = d.prompt;
    thumbUrl = d.thumb_url;
  } catch {
    return NextResponse.json(
      { detail: "Không lấy được prompt thumbnail từ backend." },
      { status: 500 },
    );
  }

  // 2. Download the source thumbnail (now served locally by the backend).
  const tmpDir = path.join(os.tmpdir(), "gemini-thumb");
  fs.mkdirSync(tmpDir, { recursive: true });
  const inputPath = path.join(tmpDir, `${videoId}.jpg`);
  try {
    const src = thumbUrl.startsWith("/") ? `${BACKEND_URL}${thumbUrl}` : thumbUrl;
    const res = await fetch(src, {
      headers: { "User-Agent": USER_AGENT, Referer: "https://www.douyin.com/" },
    });
    if (!res.ok) throw new Error(`download thumb failed: ${res.status}`);
    fs.writeFileSync(inputPath, Buffer.from(await res.arrayBuffer()));
  } catch {
    return NextResponse.json(
      { detail: "Không tải được ảnh thumbnail gốc." },
      { status: 500 },
    );
  }

  // 3. Drive gemini.google.com via puppeteer.
  let handle;
  try {
    handle = await openGeminiBrowser();
  } catch {
    return NextResponse.json(
      { detail: "Không mở được Chrome." },
      { status: 500 },
    );
  }

  try {
    const page = await handle.browser.newPage();
    await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const loggedIn = await isGeminiLoggedIn(page);
    if (!loggedIn) {
      // Leave the browser open at gemini.google.com so the user can log in once.
      return NextResponse.json({
        status: "need_login",
        detail:
          "Chưa đăng nhập Gemini — đăng nhập Google trong cửa sổ Chrome vừa mở (gemini.google.com) rồi chạy lại bước này.",
      });
    }

    await attachGeminiImage(page, inputPath);
    let fullPrompt = `${prompt}\n\nDùng khả năng tạo/sửa ảnh của bạn để chỉnh sửa ảnh đính kèm phía trên, giữ nguyên nhân vật, bố cục và phong cách.`;
    if (extraInstructions) {
      fullPrompt += `\n\nYêu cầu thêm: ${extraInstructions}`;
    }
    await submitGeminiPrompt(page, fullPrompt);

    const imageBuf = await extractGeminiImage(page);
    if (!imageBuf) {
      return NextResponse.json(
        {
          detail:
            "Gemini không trả về ảnh (bị từ chối, hết quota hoặc hết thời gian chờ).",
        },
        { status: 500 },
      );
    }

    // 4. Persist the result to the standard thumbnail path on the backend so
    //    the YouTube upload step picks it up.
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(imageBuf)], { type: "image/png" }), "thumbnail.png");
    const saveRes = await fetch(`${BACKEND_URL}/api/thumbnail/${videoId}/gpt-result`, {
      method: "POST",
      body: form,
    });
    if (!saveRes.ok) {
      return NextResponse.json(
        { detail: "Không lưu được ảnh kết quả lên backend." },
        { status: 500 },
      );
    }
    const saved = await saveRes.json();

    return NextResponse.json({
      status: "done",
      thumbnail_url: saved.thumbnail_url || `/api/thumbnail/${videoId}`,
    });
  } finally {
    await closeGeminiBrowser(handle).catch(() => {});
  }
}
