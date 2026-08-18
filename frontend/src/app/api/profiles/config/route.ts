import fs from "fs";
import { NextResponse } from "next/server";
import {
  readProfileConfig,
  writeProfileConfig,
  resolveProfileDir,
  type ProfileConfig,
} from "@/lib/subtitle-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const cfg = readProfileConfig();
  const douyin = resolveProfileDir("douyin");
  const chatgpt = resolveProfileDir("chatgpt");
  return NextResponse.json({
    config: cfg,
    resolved: {
      douyin: { path: douyin, exists: fs.existsSync(douyin) },
      chatgpt: { path: chatgpt, exists: fs.existsSync(chatgpt) },
    },
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Partial<ProfileConfig> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ detail: "Invalid body" }, { status: 400 });
  }
  const cfg: ProfileConfig = { ...readProfileConfig() };
  for (const key of ["douyin", "chatgpt"] as const) {
    const val = body[key];
    if (typeof val === "string") {
      const trimmed = val.trim();
      cfg[key] = trimmed || undefined;
      if (trimmed === "") delete cfg[key];
    }
  }
  writeProfileConfig(cfg);
  return NextResponse.json({ status: "ok", config: cfg });
}
