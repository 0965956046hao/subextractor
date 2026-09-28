import { NextResponse } from "next/server";
import {
  openBrowser,
  closeBrowser,
  disconnectBrowser,
  loadCookies,
  saveCookies,
  type BrowserHandle,
} from "@/lib/douyin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOGIN_COOKIES = ["sessionid", "sessionid_ss", "sid_tt", "sid_guard"];
const WAIT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 2000;

type LoginStatus = "idle" | "waiting" | "done" | "timeout" | "error";

// Single-flight state (module scope — one login attempt at a time).
// NOTE: Next.js dev server runs a single Node process, so this survives
// across requests. A server restart resets it to idle.
const state: { status: LoginStatus; detail?: string } = { status: "idle" };

async function waitForLogin(handle: BrowserHandle): Promise<void> {
  const page = await handle.browser.newPage();
  try {
    await loadCookies(page);
    await page.goto("https://www.douyin.com", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const cookies = await page.cookies();
        if (cookies.some((c) => LOGIN_COOKIES.includes(c.name))) {
          await saveCookies(page);
          state.status = "done";
          return;
        }
      } catch {
        // page may be navigating — retry on next tick
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    state.status = "timeout";
    state.detail = "Hết 3 phút chờ quét QR — hãy thử lại.";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.status = "error";
    state.detail = msg;
  } finally {
    try {
      if (handle.persistent) {
        await page.close().catch(() => {});
        await disconnectBrowser(handle).catch(() => {});
      } else {
        await closeBrowser(handle).catch(() => {});
      }
    } catch {
      // ignore cleanup errors
    }
  }
}

/** Start a visible-Chrome Douyin login. Returns immediately; the settings
 *  page polls GET for completion. Refuses a second attempt while one waits. */
export async function POST() {
  if (state.status === "waiting") {
    return NextResponse.json({ status: "waiting" });
  }
  let handle: BrowserHandle;
  try {
    // Visible window: reuse the user's Chrome if present, else kill the
    // lingering headless holder and launch a fresh visible one (openBrowser).
    // NOTE: this disconnects any headless scan running on the same profile.
    handle = await openBrowser({ headless: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.status = "error";
    state.detail = msg;
    return NextResponse.json(
      {
        status: "error",
        detail:
          `Không mở được Chrome: ${msg}. ` +
          "Tắt hết Chrome đang chạy rồi thử lại.",
      },
      { status: 500 },
    );
  }
  state.status = "waiting";
  state.detail = undefined;
  // Fire-and-forget: the waiter resolves via module state, polled by GET.
  void waitForLogin(handle);
  return NextResponse.json({ status: "waiting" });
}

/** Poll the in-flight (or finished) login attempt. */
export async function GET() {
  return NextResponse.json({ ...state });
}
