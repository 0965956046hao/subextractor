import puppeteer, { type Browser, type ElementHandle, type Page } from "puppeteer-core";
import { CHROME_PATH, killChromeOnProfile, type BrowserHandle } from "./douyin";
import { resolveProfileDir } from "./subtitle-profile";

/**
 * Drive chatgpt.com from the user's browser to generate/edit an image.
 *
 * ChatGPT has no public (free) image-edit API, so we automate the real chat
 * surface with puppeteer-core — mirroring how the Douyin flows drive Chrome.
 * A dedicated visible Chrome profile is used so the user can log in / pass
 * Cloudflare once; the login then persists across runs.
 */

export const CHATGPT_URL =
  process.env.CHATGPT_URL || "https://chatgpt.com/";

export const CHATGPT_PORT = Number(process.env.CHATGPT_PORT || "9223");

export const CHATGPT_PROFILE_DIR = resolveProfileDir("chatgpt");

// Visible by default — the user must be able to complete login / a Cloudflare
// check the first time. Set CHATGPT_HEADLESS=false to force headless.
export const CHATGPT_HEADLESS =
  process.env.CHATGPT_HEADLESS === undefined
    ? false
    : process.env.CHATGPT_HEADLESS !== "false";

const LOGIN_TIMEOUT_MS = 35_000;
const GENERATE_TIMEOUT_MS = Number(process.env.CHATGPT_GENERATE_TIMEOUT || "240000");

/** Reuse an already-running visible Chrome (shared profile) or launch a new one. */
export async function openChatGptBrowser(): Promise<BrowserHandle> {
  const endpoints = [
    `http://localhost:${CHATGPT_PORT}`,
    process.env.DOUYIN_CDP_URL || "http://localhost:9222",
  ];
  for (const endpoint of endpoints) {
    let browser: Browser | null = null;
    try {
      browser = await puppeteer.connect({
        browserURL: endpoint,
        defaultViewport: null,
      });
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
  // Kill any headless instance holding our profile lock so we can open a
  // visible window for login.
  killChromeOnProfile(CHATGPT_PROFILE_DIR);
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
}

/** Detach but leave the ChatGPT Chrome (and its profile) running. */
export async function closeBrowser(handle: BrowserHandle): Promise<void> {
  await handle.browser.disconnect();
}

/**
 * True when the chat composer is present (logged in). A visible sign-in CTA
 * decides "definitely not logged in"; otherwise we poll up to LOGIN_TIMEOUT for
 * the composer in case Cloudflare / the initial load is slow.
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
    const loginCta = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll("a,button")).some((n) =>
          /log\s*in|sign\s*in/i.test((n.textContent || "").trim()),
        ),
      )
      .catch(() => false);
    if (loginCta) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** Attach a local image file to the composer via its hidden file input. */
export async function attachImage(page: Page, imagePath: string): Promise<void> {
  await page.waitForSelector("#prompt-textarea", { timeout: 30_000 });
  // Prefer the image-specific input (#upload-photos). The generic #upload-files
  // attaches the file as a plain document and ChatGPT won't see it as an image.
  const input = (
    (await page.$("#upload-photos")) ||
    (await page.$("#upload-files"))
  ) as ElementHandle<HTMLInputElement> | null;
  if (!input) throw new Error("Không tìm thấy input đính kèm ảnh");
  await input.uploadFile(imagePath);
  // Give the composer a moment to show the attachment before typing.
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