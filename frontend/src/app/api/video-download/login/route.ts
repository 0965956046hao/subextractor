import { NextResponse } from "next/server";
import {
  openBrowser,
  disconnectBrowser,
  loadCookies,
  saveCookies,
  type BrowserHandle,
} from "@/lib/douyin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOGIN_TIMEOUT = Number(process.env.DOUYIN_LOGIN_TIMEOUT || 120000);

const SESSION_COOKIE_RE = /sessionid|sid_guard/;

export async function POST() {
  let handle: BrowserHandle;
  try {
    // Login phải mở Chrome visible để user đăng nhập thủ công
    handle = await openBrowser({ headless: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        detail:
          `Không mở được Chrome: ${msg}. ` +
          "Đảm bảo Google Chrome đã cài, hoặc đang chạy với --remote-debugging-port=9222.",
      },
      { status: 500 },
    );
  }

  try {
    const page = await handle.browser.newPage();
    await loadCookies(page);
    await page.goto("https://www.douyin.com", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    // Chờ user đăng nhập thủ công: poll cookie sessionid/sid_guard
    const start = Date.now();
    let loggedIn = false;
    // Kiểm tra cookie đã có sẵn trước khi chờ
    try {
      const cookies = await page.cookies();
      if (SESSION_COOKIE_RE.test(cookies.map((c) => c.name).join(","))) loggedIn = true;
    } catch {}

    while (!loggedIn && Date.now() - start < LOGIN_TIMEOUT) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const cookies = await page.cookies();
        if (SESSION_COOKIE_RE.test(cookies.map((c) => c.name).join(","))) {
          loggedIn = true;
          break;
        }
        // Fallback: check URL đã vào trang login thành công (có avatar/user)
        const url = page.url();
        if (url.includes("douyin.com") && !url.includes("login")) {
          // vẫn poll tiếp, nhưng nếu cookie chưa có thì chờ thêm
        }
      } catch {}
    }

    await saveCookies(page);

    // Để browser mở cho user thấy (disconnect thay vì close nếu là persistent)
    await disconnectBrowser(handle).catch(() => {});

    if (!loggedIn) {
      return NextResponse.json({
        status: "need_login",
        mode: handle.persistent ? "connect" : "launch",
        detail: "Chưa phát hiện đăng nhập. Vui lòng đăng nhập Douyin trong cửa sổ Chrome vừa mở rồi bấm lại.",
      });
    }

    return NextResponse.json({
      status: "ok",
      mode: handle.persistent ? "connect" : "launch",
    });
  } catch (err) {
    await disconnectBrowser(handle).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { detail: `Không mở được Douyin: ${msg}` },
      { status: 500 },
    );
  }
}
