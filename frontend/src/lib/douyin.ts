import fs from "fs";
import os from "os";
import path from "path";
import puppeteer, { type Browser, type Page, type Cookie, type CookieParam } from "puppeteer-core";

export const CHROME_PATH =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const CDP_URL = process.env.DOUYIN_CDP_URL || "http://localhost:9222";

const CDP_PORT = (() => {
  const m = CDP_URL.match(/:(\d+)(?:\/|$)/);
  return m ? m[1] : "9222";
})();

export const PROFILE_DIR =
  process.env.DOUYIN_PROFILE_DIR ||
  path.join(os.homedir(), ".douyin-video-downloader");

export const COOKIE_FILE =
  process.env.DOUYIN_COOKIE_FILE ||
  path.join(os.homedir(), ".douyin-session", "cookies.json");

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

export const SOURCE_SELECTOR = "xg-video-container video source[src]";

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

export type BrowserHandle = { browser: Browser; persistent: boolean };

/**
 * Attach to an already-running Chrome via CDP if it exposes the debugging
 * port; otherwise launch a fresh Chrome bound to that same port + persistent
 * profile, so every later call can `connect()` instead of re-launching.
 */
export async function openBrowser(): Promise<BrowserHandle> {
  try {
    const browser = await puppeteer.connect({
      browserURL: CDP_URL,
      defaultViewport: null,
    });
    return { browser, persistent: true };
  } catch {
    const browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: false,
      userDataDir: PROFILE_DIR,
      args: [
        "--disable-blink-features=AutomationControlled",
        `--remote-debugging-port=${CDP_PORT}`,
      ],
      defaultViewport: null,
    });
    return { browser, persistent: false };
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
    await handle.browser.close();
  }
}
