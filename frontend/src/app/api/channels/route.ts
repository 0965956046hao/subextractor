import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import {
  openBrowser,
  closeBrowser,
  loadCookies,
  saveCookies,
  USER_AGENT,
} from "@/lib/douyin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHANNELS_FILE = path.join(
  process.env.CHANNELS_FILE || path.join(os.tmpdir(), "subextractor-channels.json"),
);

interface Channel {
  id: string;
  url: string;
  name: string;
  avatar_url: string;
  added_at: string;
}

function loadChannels(): Channel[] {
  try {
    if (!fs.existsSync(CHANNELS_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(CHANNELS_FILE, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveChannels(channels: Channel[]): void {
  fs.mkdirSync(path.dirname(CHANNELS_FILE), { recursive: true });
  fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2), "utf8");
}

function extractName(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const userPart = parts.find((p) => p.startsWith("user/")) || parts[parts.length - 1];
    return userPart.replace("user/", "").slice(0, 20) || url;
  } catch {
    return url.slice(0, 40);
  }
}

async function scrapeAvatar(channelUrl: string): Promise<{ name: string; avatar: string }> {
  let handle;
  try {
    handle = await openBrowser({ headless: true });
  } catch {
    return { name: "", avatar: "" };
  }

  let name = "";
  let avatar = "";

  try {
    const page = await handle.browser.newPage();
    if (!handle.persistent) await page.setUserAgent(USER_AGENT);
    await loadCookies(page);

    const profileReady = new Promise<void>((resolve) => {
      let done = false;
      page.on("response", async (resp) => {
        if (done) return;
        const u = resp.url();
        if (!u.includes("/aweme/v1/web/user/profile/other/")) return;
        try {
          const data = await resp.json();
          const user = data?.user;
          if (!user) return;
          if (user.nickname) name = user.nickname;
          const avatarList = user?.avatar_medium?.url_list;
          if (Array.isArray(avatarList) && avatarList.length > 0) {
            avatar = avatarList[0];
          }
          done = true;
          resolve();
        } catch {
          // skip
        }
      });
    });

    await page.goto(channelUrl, { waitUntil: "networkidle2", timeout: 45000 });
    await Promise.race([profileReady, new Promise((r) => setTimeout(r, 15000))]);

    // Fallback: try to get name from DOM if API didn't return it
    if (!name) {
      try {
        name = await page.evaluate(() => {
          const el = document.querySelector(
            '[data-e2e="user-info"] .j5WZzJdp, .e6wsjNLL span, .QXuHv3I3',
          );
          return el?.textContent?.trim() || "";
        });
      } catch {
        // ignore
      }
    }

    await saveCookies(page);
  } catch {
    // ignore
  }

  await closeBrowser(handle).catch(() => {});
  return { name, avatar };
}

export async function GET() {
  return NextResponse.json({ channels: loadChannels() });
}

export async function POST(req: NextRequest) {
  let body: { url?: string; name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "Invalid JSON" }, { status: 400 });
  }

  const url = (body.url || "").trim();
  if (!url)
    return NextResponse.json({ detail: "URL is required" }, { status: 400 });

  if (!url.includes("douyin.com/user/") && !url.includes("douyin.com/user\\"))
    return NextResponse.json(
      { detail: "Chỉ hỗ trợ link kênh Douyin (douyin.com/user/...)" },
      { status: 400 },
    );

  const channels = loadChannels();
  if (channels.some((c) => c.url === url))
    return NextResponse.json({ detail: "URL đã tồn tại" }, { status: 409 });

  // Scrape avatar + name from the channel page
  const scraped = await scrapeAvatar(url);

  const ch: Channel = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    url,
    name: body.name || scraped.name || extractName(url),
    avatar_url: scraped.avatar,
    added_at: new Date().toISOString(),
  };
  channels.push(ch);
  saveChannels(channels);
  return NextResponse.json({ channel: ch });
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id)
    return NextResponse.json({ detail: "id is required" }, { status: 400 });

  const channels = loadChannels();
  const filtered = channels.filter((c) => c.id !== id);
  if (filtered.length === channels.length)
    return NextResponse.json({ detail: "Not found" }, { status: 404 });

  saveChannels(filtered);
  return NextResponse.json({ status: "ok" });
}
