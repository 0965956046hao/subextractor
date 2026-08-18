import fs from "fs";
import { NextResponse } from "next/server";
import { resolveProfileDir } from "@/lib/subtitle-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const douyin = resolveProfileDir("douyin");
  const chatgpt = resolveProfileDir("chatgpt");
  return NextResponse.json({
    douyin: { exists: fs.existsSync(douyin), path: douyin },
    chatgpt: { exists: fs.existsSync(chatgpt), path: chatgpt },
  });
}
