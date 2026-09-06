import puppeteer, { type Browser, type ElementHandle, type Page } from "puppeteer-core";
import { CHROME_PATH, ensureProfileFree, type BrowserHandle } from "./douyin";
import { resolveProfileDir } from "./subtitle-profile";

/**
 * Drive gemini.google.com from the user's browser to generate/edit an image.
 *
 * Mirrors lib/chatgpt.ts: same shared Chrome profile (Google login persists),
 * visible browser, puppeteer-core automation. Gemini-specific DOM notes:
 * - Prompt box is a Quill `rich-textarea .ql-editor` (contenteditable).
 * - The file input is created dynamically on upload click and immediately
 *   opens the OS file picker → use page.waitForFileChooser() + accept it.
 * - Generated images render inside the response; resolved in-page (auth
 *   cookies) to base64 like the ChatGPT flow.
 */

export const GEMINI_URL =
  process.env.GEMINI_URL || "https://gemini.google.com/app";

export const GEMINI_PORT = Number(process.env.GEMINI_PORT || "9224");

// Same profile dir as Douyin/ChatGPT so the Google login persists.
export const GEMINI_PROFILE_DIR = resolveProfileDir("douyin");

export const GEMINI_HEADLESS =
  process.env.GEMINI_HEADLESS === undefined
    ? false
    : process.env.GEMINI_HEADLESS !== "false";

const LOGIN_TIMEOUT_MS = 120_000;
const GENERATE_TIMEOUT_MS = Number(process.env.GEMINI_GENERATE_TIMEOUT || "240000");

/** Reuse an already-running visible Chrome (shared profile) or launch a new one. */
export async function openGeminiBrowser(): Promise<BrowserHandle> {
  const endpoints = [
    `http://localhost:${GEMINI_PORT}`,
    `http://localhost:9223`,
    process.env.DOUYIN_CDP_URL || "http://localhost:9222",
  ];

  // 1. Try connecting to an already-running visible Chrome — reuse it.
  for (const endpoint of endpoints) {
    let browser: Browser | null = null;
    try {
      browser = await puppeteer.connect({
        browserURL: endpoint,
        defaultViewport: null,
      });
      const version = await browser.version();
      if (/headlesschrome/i.test(version)) {
        // Found headless — kill it, then continue to try the other endpoint.
        await browser.disconnect().catch(() => {});
        ensureProfileFree(GEMINI_PROFILE_DIR);
        continue;
      }
      return { browser, persistent: true };
    } catch {
      await browser?.disconnect().catch(() => {});
      // try next endpoint
    }
  }

  // 2. No visible Chrome found. Free the profile (TERM → KILL → stale
  // SingletonLock cleanup), then launch fresh.
  ensureProfileFree(GEMINI_PROFILE_DIR);

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) ensureProfileFree(GEMINI_PROFILE_DIR, 8000);
    try {
      const browser = await puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: GEMINI_HEADLESS,
        userDataDir: GEMINI_PROFILE_DIR,
        args: [
          "--disable-blink-features=AutomationControlled",
          `--remote-debugging-port=${GEMINI_PORT}`,
        ],
        defaultViewport: null,
      });
      return { browser, persistent: false };
    } catch (err) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        throw err;
      }
    }
  }
  throw new Error("Không khởi động được Chrome sau 3 lần thử");
}

/** Detach but leave the Gemini Chrome (and its profile) running. */
export async function closeGeminiBrowser(handle: BrowserHandle): Promise<void> {
  await handle.browser.disconnect();
}

/**
 * True once the Gemini prompt box is present. A Google sign-in redirect means
 * "not logged in *yet*" — keep polling until the deadline like the ChatGPT flow.
 */
export async function isGeminiLoggedIn(page: Page): Promise<boolean> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const url = page.url();
    const composer = await page
      .$('rich-textarea .ql-editor, div[contenteditable="true"]')
      .catch(() => null);
    if (composer && !/accounts\.google\.com/.test(url)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Attach a local image via Gemini's upload menu ("Nội dung tải lên và công
 * cụ" → "Tải tệp lên"). Puppeteer's waitForFileChooser intercepts the OS
 * picker at CDP level, so no native dialog ever appears (do NOT patch
 * input.click — that would suppress the chooser event itself).
 */
export async function attachGeminiImage(page: Page, imagePath: string): Promise<void> {
  await page
    .waitForSelector('rich-textarea .ql-editor, div[contenteditable="true"]', {
      timeout: 30_000,
    })
    .catch(() => {
      throw new Error("Không tìm thấy ô nhập prompt Gemini");
    });

  // 1. Open the upload menu (aria-label is localized, e.g. Vietnamese
  // "Nội dung tải lên và công cụ").
  const menuBtns = await page.$$("button");
  let menuBtn: ElementHandle<Element> | null = null;
  for (const b of menuBtns) {
    const label = await b
      .evaluate((el) => (el as HTMLElement).getAttribute("aria-label") || "")
      .catch(() => "");
    if (/tải lên|upload|add/i.test(label)) {
      const visible = await b
        .evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .catch(() => false);
      if (visible) {
        menuBtn = b;
        break;
      }
    }
  }
  if (!menuBtn) throw new Error("Không tìm thấy nút tải lên trên Gemini");
  await menuBtn.click().catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));

  // 2. Click "Tải tệp lên" / "Upload files" while intercepting the picker.
  const items = await page.$$(
    '[role="menuitem"],[role="menuitemradio"],.mat-mdc-menu-item,button',
  );
  let uploadItem: ElementHandle<Element> | null = null;
  for (const it of items) {
    const text = await it
      .evaluate((el) => ((el as HTMLElement).innerText || "").trim().slice(0, 40))
      .catch(() => "");
    if (!/tải tệp lên|upload files/i.test(text)) continue;
    const visible = await it
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .catch(() => false);
    if (visible) {
      uploadItem = it;
      break;
    }
  }
  if (!uploadItem) throw new Error("Không tìm thấy mục 'Tải tệp lên' trên Gemini");
  const [chooser] = await Promise.all([
    page.waitForFileChooser({ timeout: 8000 }),
    uploadItem.click().catch(() => {}),
  ]);
  await chooser.accept([imagePath]);
  // Give Gemini a moment to render the attachment preview before typing.
  await new Promise((r) => setTimeout(r, 2500));
}

/** Type the prompt into Gemini's Quill editor and submit exactly ONE message. */
export async function submitGeminiPrompt(page: Page, prompt: string): Promise<void> {
  const composer = await page.$('rich-textarea .ql-editor, div[contenteditable="true"]');
  if (!composer) throw new Error("Không tìm thấy ô nhập prompt");
  await composer.click();
  await page.keyboard.down("Meta");
  await page.keyboard.press("a");
  await page.keyboard.up("Meta");
  await page.keyboard.press("Backspace");
  // Collapse newlines: a plain Enter submits, so send as one line like the GPT flow.
  const oneLine = prompt.replace(/\s*\n+\s*/g, " ").trim();
  await page.keyboard.type(oneLine, { delay: 5 });
  // Prefer the send button; fall back to Enter.
  const sendBtn = await page.$(
    'button[aria-label="Send message"], button[aria-label*="Send"]',
  );
  if (sendBtn) {
    await sendBtn.click().catch(() => {});
  } else {
    await page.keyboard.press("Enter");
  }
}

/**
 * Wait for a NEW image to appear in Gemini's response and return its bytes.
 * Baseline snapshots existing <img> srcs first so a stale thumbnail from an
 * earlier turn is never grabbed.
 */
export async function extractGeminiImage(page: Page): Promise<Buffer | null> {
  const baseline = new Set(
    await page
      .$$eval("img", (imgs) =>
        imgs.map((i) => (i as HTMLImageElement).getAttribute("src") || ""),
      )
      .catch(() => [] as string[]),
  );

  const deadline = Date.now() + GENERATE_TIMEOUT_MS;
  let src: string | null = null;
  while (Date.now() < deadline) {
    try {
      src = await page.evaluate((seen: string[]) => {
        const imgs = Array.from(
          document.querySelectorAll<HTMLImageElement>("img"),
        ).filter((el) => {
          const s = el.getAttribute("src") || "";
          if (!s || seen.includes(s)) return false;
          if (!el.complete || el.naturalWidth < 100) return false;
          // Skip avatars/icons/logos — generated images are large.
          if (el.naturalWidth < 256 && el.naturalHeight < 256) return false;
          if (/logo|avatar|icon|profile/i.test(s)) return false;
          return true;
        });
        // Prefer the largest new image (the generated result).
        imgs.sort(
          (a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight,
        );
        return imgs.length ? imgs[0].getAttribute("src") : null;
      }, [...baseline]);
    } catch {
      src = null;
    }
    if (src) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!src) return null;

  const base64 = await resolveImageAsBase64(page, src);
  if (!base64) return null;
  return Buffer.from(base64, "base64");
}

/** Resolve a blob:/data:/http(s) image URL to a base64 payload in-page (authed).
 *
 * Canvas snapshot first: blob: URLs sometimes refuse fetch() but draw fine
 * (same-origin → canvas stays clean). Falls back to fetch for http(s) URLs.
 */
async function resolveImageAsBase64(page: Page, url: string): Promise<string | null> {
  if (url.startsWith("data:")) {
    const m = url.match(/^data:[^;]+;base64,([\s\S]*)$/);
    return m ? m[1] : null;
  }
  try {
    const dataUrl = await page.evaluate((s) => {
      const el = Array.from(document.querySelectorAll<HTMLImageElement>("img")).find(
        (i) => i.getAttribute("src") === s,
      );
      if (!el || !el.complete || el.naturalWidth < 10) return null;
      try {
        const c = document.createElement("canvas");
        c.width = el.naturalWidth;
        c.height = el.naturalHeight;
        c.getContext("2d")!.drawImage(el, 0, 0);
        return c.toDataURL("image/png");
      } catch {
        return null;
      }
    }, url);
    if (dataUrl) {
      const m = dataUrl.match(/^data:[^;]+;base64,([\s\S]*)$/);
      if (m) return m[1];
    }
  } catch {
    // fall through to fetch
  }
  try {
    return await page.evaluate(async (u) => {
      const resp = await fetch(u);
      if (!resp.ok) return "";
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return btoa(bin);
    }, url);
  } catch {
    return null;
  }
}
