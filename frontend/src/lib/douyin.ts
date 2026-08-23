import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import puppeteer, {
  type Browser,
  type Page,
  type Cookie,
  type CookieParam,
} from "puppeteer-core";
import { resolveProfileDir } from "./subtitle-profile";

export const CHROME_PATH =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const CDP_URL = process.env.DOUYIN_CDP_URL || "http://localhost:9222";

const CDP_PORT = (() => {
  const m = CDP_URL.match(/:(\d+)(?:\/|$)/);
  return m ? m[1] : "9222";
})();

export const PROFILE_DIR = resolveProfileDir("douyin");

export const COOKIE_FILE =
  process.env.DOUYIN_COOKIE_FILE ||
  path.join(os.homedir(), ".douyin-session", "cookies.json");

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

export const SOURCE_SELECTORS = [
  "xg-video-container video source[src]",
  "xg-video-container source[src]",
  "xg-video-container video[src]",
];

const URL_HINTS = [
  "zjcdn",
  "aweme/v1/play",
  "video/tos",
  "douyinvod",
  "bytecdn",
  "amemv",
  "mime_type=video_mp4",
];

export function isVideoUrl(u: string): boolean {
  const low = u.toLowerCase();
  return /^https?:\/\//.test(low) && URL_HINTS.some((h) => low.includes(h));
}

export function isMp4Url(u: string): boolean {
  return /\.mp4(\?|$)|video_mp4|mime_type=video_mp4/i.test(u);
}

export function classifyTrack(u: string): "video" | "audio" | "unknown" {
  if (/media-audio|media_audio|audio-und|mp4a/i.test(u)) return "audio";
  if (/media-video|media_video|video-/i.test(u)) return "video";
  return "unknown";
}

export type BrowserHandle = { browser: Browser; persistent: boolean };

export const HEADLESS =
  process.env.DOUYIN_HEADLESS === undefined
    ? true
    : process.env.DOUYIN_HEADLESS !== "false";

/**
 * Attach to an already-running Chrome via CDP if it exposes the debugging
 * port; otherwise launch a fresh Chrome bound to that same port + persistent
 * profile, so every later call can `connect()` instead of re-launching.
 *
 * Douyin and ChatGPT share ONE profile dir, so if a Chrome (e.g. the ChatGPT
 * instance on its port) is already running on that profile, reuse it instead
 * of launching a second Chrome — Chrome can't open two instances of the same
 * user-data-dir.
 *
 * When a visible window is requested (headless: false — login flow), we only
 * reuse a Chrome that is actually visible (non-headless). A lingering headless
 * instance from the download flow must NOT be reused, otherwise the login
 * would silently drive an invisible browser. In that case we kill the headless
 * instance on our profile and launch a fresh visible one.
 */
export async function openBrowser(options?: {
  headless?: boolean;
}): Promise<BrowserHandle> {
  const headless = options?.headless ?? HEADLESS;
  const endpoints = [
    CDP_URL,
    process.env.CHATGPT_CDP_URL ||
      `http://localhost:${process.env.CHATGPT_PORT || "9223"}`,
  ];
  for (const endpoint of endpoints) {
    let browser: Browser | null = null;
    try {
      browser = await puppeteer.connect({
        browserURL: endpoint,
        defaultViewport: null,
      });
      if (headless) return { browser, persistent: true };
      const version = await browser.version();
      if (/headlesschrome/i.test(version)) {
        await browser.disconnect().catch(() => {});
        continue; // headless instance — not usable for a visible login
      }
      return { browser, persistent: true };
    } catch {
      await browser?.disconnect().catch(() => {});
      // try next endpoint
    }
  }
  // For a visible login, make sure no headless instance holds our profile lock.
  if (!headless) killChromeOnProfile(PROFILE_DIR);
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless,
    userDataDir: PROFILE_DIR,
    args: [
      "--disable-blink-features=AutomationControlled",
      `--remote-debugging-port=${CDP_PORT}`,
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-features=Translate,MediaRouter",
    ],
    defaultViewport: null,
  });
  return { browser, persistent: false };
}

/** Kill any Chrome running with the given user-data-dir (profile lock). */
export function killChromeOnProfile(profileDir: string): void {
  try {
    const out = execSync(`pgrep -f "user-data-dir=${profileDir}"`, {
      encoding: "utf8",
    });
    for (const pid of out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        // already gone
      }
    }
  } catch {
    // no matches — nothing to kill
  }
}

function toCookieParams(cookies: Cookie[]): CookieParam[] {
  return cookies.map((c) => {
    const p: CookieParam = { name: c.name, value: c.value };
    if (c.domain) p.domain = c.domain;
    if (c.path) p.path = c.path;
    if (typeof c.expires === "number") p.expires = c.expires;
    if (c.httpOnly) p.httpOnly = c.httpOnly;
    if (c.secure) p.secure = c.secure;
    if (c.sameSite) p.sameSite = c.sameSite;
    return p;
  });
}

/**
 * Load a previously saved session cookie jar into the page. Returns the
 * number of cookies restored (0 if no saved session exists yet).
 */
export async function loadCookies(page: Page): Promise<number> {
  try {
    const raw = fs.readFileSync(COOKIE_FILE, "utf8");
    const cookies = JSON.parse(raw) as CookieParam[];
    if (!Array.isArray(cookies) || cookies.length === 0) return 0;
    await page.setCookie(...cookies);
    return cookies.length;
  } catch {
    return 0;
  }
}

/**
 * Persist the current page cookies to disk so the session (e.g. a Douyin
 * login) can be reused on the next run. Returns the number of cookies saved.
 */
export async function saveCookies(page: Page): Promise<number> {
  try {
    const cookies = await page.cookies();
    if (cookies.length === 0) return 0;
    const cleaned = toCookieParams(cookies);
    fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cleaned, null, 2));
    return cleaned.length;
  } catch {
    return 0;
  }
}

/** Detach but leave the browser (and its tabs) running. */
export async function disconnectBrowser(handle: BrowserHandle): Promise<void> {
  await handle.browser.disconnect();
}

/** Close the browser we launched, or just disconnect if it is the user's. */
export async function closeBrowser(handle: BrowserHandle): Promise<void> {
  if (handle.persistent) {
    await handle.browser.disconnect();
  } else {
    await handle.browser.close().catch(() => {});
  }
}
