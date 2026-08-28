import puppeteer, { type Browser, type ElementHandle, type Page } from "puppeteer-core";
import { CHROME_PATH, killChromeOnProfile, type BrowserHandle } from "./douyin";
import { resolveProfileDir } from "./subtitle-profile";
import { execSync } from "child_process";

/**
 * Drive chatgpt.com from the user's browser to generate/edit an image.
 *
 * ChatGPT has no public (free) image-edit API, so we automate the real chat
 * surface with puppeteer-core — mirroring how the Douyin flows drive Chrome.
 * A dedicated visible Chrome profile is used so the user can log in / pass
 * Cloudflare once; the login then persists across runs.
 *
 * Both Douyin and ChatGPT share the same Chrome profile so login persists
 * across both services.
 */

export const CHATGPT_URL =
  process.env.CHATGPT_URL || "https://chatgpt.com/";

export const CHATGPT_PORT = Number(process.env.CHATGPT_PORT || "9223");

// Use the same profile dir as Douyin so both share one Chrome profile.
export const CHATGPT_PROFILE_DIR = resolveProfileDir("douyin");

// Visible by default — the user must be able to complete login / a Cloudflare
// check the first time. Set CHATGPT_HEADLESS=false to force headless.
export const CHATGPT_HEADLESS =
  process.env.CHATGPT_HEADLESS === undefined
    ? false
    : process.env.CHATGPT_HEADLESS !== "false";

/** Wait until no Chrome process holds the given profile dir. */
function waitForProfileRelease(profileDir: string, maxWaitMs = 5000): void {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const out = execSync(`pgrep -f "user-data-dir=${profileDir}"`, { encoding: "utf8" }).trim();
      if (!out) return; // no Chrome on this profile
    } catch {
      return; // pgrep exited non-zero = no matches
    }
    execSync("sleep 0.5");
  }
}

const LOGIN_TIMEOUT_MS = 120_000;
const GENERATE_TIMEOUT_MS = Number(process.env.CHATGPT_GENERATE_TIMEOUT || "240000");

/** Reuse an already-running visible Chrome (shared profile) or launch a new one. */
export async function openChatGptBrowser(): Promise<BrowserHandle> {
  const endpoints = [
    `http://localhost:${CHATGPT_PORT}`,
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
        killChromeOnProfile(CHATGPT_PROFILE_DIR);
        waitForProfileRelease(CHATGPT_PROFILE_DIR, 5000);
        continue;
      }
      return { browser, persistent: true };
    } catch {
      await browser?.disconnect().catch(() => {});
      // try next endpoint
    }
  }

  // 2. No visible Chrome found. Kill any lingering headless, then launch fresh.
  killChromeOnProfile(CHATGPT_PROFILE_DIR);
  waitForProfileRelease(CHATGPT_PROFILE_DIR, 5000);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const browser = await puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: CHATGPT_HEADLESS,
        userDataDir: CHATGPT_PROFILE_DIR,
        args: [
          "--disable-blink-features=AutomationControlled",
          `--remote-debugging-port=${CHATGPT_PORT}`,
        ],
        defaultViewport: null,
      });
      return { browser, persistent: false };
    } catch (err) {
      if (attempt < 2) {
        killChromeOnProfile(CHATGPT_PROFILE_DIR);
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        throw err;
      }
    }
  }
  throw new Error("Không khởi động được Chrome sau 3 lần thử");
}

/** Detach but leave the ChatGPT Chrome (and its profile) running. */
export async function closeBrowser(handle: BrowserHandle): Promise<void> {
  await handle.browser.disconnect();
}

/**
 * True once the chat composer is present (i.e. logged in). We poll up to
 * LOGIN_TIMEOUT_MS — the first time Chrome opens the user is almost certainly
 * NOT logged in yet, so we must keep waiting (not bail) while they sign in.
 * Only return false after the full window elapses with no composer.
 *
 * NOTE: do not use page.waitForFunction with tri-state string returns here —
 * waitForFunction resolves on the first truthy value, so a still-loading page
 * ("loading") would resolve immediately and look like "logged out".
 */
export async function isChatGptLoggedIn(page: Page): Promise<boolean> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const composer = await page.$("#prompt-textarea").catch(() => null);
    if (composer) return true;
    // A sign-in CTA means "not logged in *yet*" — the user may be mid-login, so
    // we keep polling instead of bailing. Return false only after the deadline.
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** Attach a local image file to the composer via its hidden file input. */
export async function attachImage(page: Page, imagePath: string): Promise<void> {
  await page.waitForSelector("#prompt-textarea", { timeout: 30_000 });
  // Prefer the image-specific input (#upload-photos). The generic #upload-files
  // attaches the file as a plain document and ChatGPT won't see it as an image.
  // ChatGPT mounts the file input lazily. Find it by the stable
  // `input[type="file"]` selector first, falling back to the legacy ids; if it
  // isn't in the DOM yet, click the "+"/attach button to reveal it.
  let input = (await page.$("input[type='file']")) as ElementHandle<HTMLInputElement> | null;
  if (!input) {
    const attachBtn =
      (await page.$("button[aria-label*='Attach']")) ||
      (await page.$("[data-testid='add-attachment-button']")) ||
      (await page.$("button[aria-label*='Add']"));
    if (attachBtn) {
      await attachBtn.click().catch(() => {});
      await new Promise((r) => setTimeout(r, 800));
    }
    input = (await page.$("input[type='file']")) as ElementHandle<HTMLInputElement> | null;
  }
  if (!input) {
    input = ((await page.$("#upload-photos")) ||
      (await page.$("#upload-files"))) as ElementHandle<HTMLInputElement> | null;
  }
  if (!input) throw new Error("Không tìm thấy input đính kèm ảnh trên ChatGPT");
  await input.uploadFile(imagePath);
  // Confirm the file was actually accepted by the input before typing.
  await page
    .waitForFunction(
      (el) =>
        !!(el as HTMLInputElement).files && (el as HTMLInputElement).files!.length > 0,
      { timeout: 10000 },
      input,
    )
    .catch(() => {});
  // Give the composer a moment to render the attachment preview before typing.
  await new Promise((r) => setTimeout(r, 2000));
}

/** Type the prompt into the composer and submit exactly ONE message. */
export async function submitPrompt(page: Page, prompt: string): Promise<void> {
  const composer = await page.$("#prompt-textarea");
  if (!composer) throw new Error("Không tìm thấy ô nhập prompt");
  await composer.click();
  // Clear any restored draft before typing our prompt.
  await page.keyboard.down("Meta");
  await page.keyboard.press("a");
  await page.keyboard.up("Meta");
  await page.keyboard.press("Backspace");
  // puppeteer's keyboard.type maps "\n" to Enter, which would split the prompt
  // into multiple messages. Collapse to a single line so exactly one message
  // (image + prompt) is sent before we wait for the generated image.
  const oneLine = prompt.replace(/\s*\n+\s*/g, " ").trim();
  await page.keyboard.type(oneLine, { delay: 5 });
  await page.keyboard.press("Enter");
}

/**
 * Wait for the assistant's newest message to contain a generated image and
 * return its bytes. Handles blob:/data: image URLs (resolved in-page).
 * Returns null if generation never produced an image (refusal / quota).
 */
export async function extractGeneratedImage(page: Page): Promise<Buffer | null> {
  const src = await page.waitForFunction(
    () => {
      // ChatGPT renders generated images as <img alt="Generated image"> (with
      // or without a trailing ": <title>"). The title is not always present, so
      // match the prefix and require the image to be fully loaded to avoid
      // grabbing a still-streaming placeholder.
      const img = Array.from(
        document.querySelectorAll<HTMLImageElement>("img[alt]"),
      ).find((el) => {
        const alt = (el.getAttribute("alt") || "").trim().toLowerCase();
        if (!alt.startsWith("generated image")) return false;
        if (!el.complete || el.naturalWidth < 100) return false;
        const s = el.getAttribute("src") || "";
        return (
          s.startsWith("blob:") ||
          s.startsWith("data:image") ||
          s.startsWith("/backend-api/estuary/content") ||
          s.startsWith("https://chatgpt.com/backend-api/estuary/content")
        );
      });
      return img ? img.getAttribute("src") : null;
    },
    { timeout: GENERATE_TIMEOUT_MS, polling: 2000 },
  );

  const imageUrl = (await src.jsonValue()) as string;
  if (!imageUrl) return null;

  const base64 = await resolveImageAsBase64(page, imageUrl);
  if (!base64) return null;
  return Buffer.from(base64, "base64");
}

/** Resolve a blob:/data:/http(s) image URL to a base64 payload. */
async function resolveImageAsBase64(page: Page, url: string): Promise<string | null> {
  if (url.startsWith("data:")) {
    const m = url.match(/^data:[^;]+;base64,([\s\S]*)$/);
    return m ? m[1] : null;
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