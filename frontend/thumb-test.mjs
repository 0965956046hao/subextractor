import fs from "fs";
import os from "os";
import path from "path";
import puppeteer from "puppeteer-core";

const CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const COOKIE_FILE = path.join(os.homedir(), ".douyin-session", "cookies.json");
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const PROFILE_DIR = path.join(os.homedir(), ".subextractor", "profiles", "douyin");
const CDP_PORT = "9222";

const url = process.argv[2];
if (!url) {
  console.error("usage: node thumb-test.mjs <video-url>");
  process.exit(1);
}

async function loadCookies(page) {
  try {
    const raw = fs.readFileSync(COOKIE_FILE, "utf8");
    const cookies = JSON.parse(raw);
    if (Array.isArray(cookies) && cookies.length) {
      await page.setCookie(...cookies);
      console.log("[cookies] loaded", cookies.length);
      return cookies.length;
    }
  } catch (e) {
    console.log("[cookies] none:", e.message);
  }
  return 0;
}

let browser;
try {
  browser = await puppeteer.connect({ browserURL: `http://localhost:${CDP_PORT}`, defaultViewport: null });
  console.log("[browser] connected to existing chrome", CDP_PORT);
} catch {
  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    userDataDir: PROFILE_DIR,
    args: [
      "--disable-blink-features=AutomationControlled",
      `--remote-debugging-port=${CDP_PORT}`,
    ],
    defaultViewport: null,
  });
  console.log("[browser] launched fresh chrome");
}

const page = await browser.newPage();
await page.setUserAgent(USER_AGENT);
await loadCookies(page);

// log all /aweme/v1/web responses regardless
page.on("response", async (resp) => {
  const u = resp.url();
  if (u.includes("aweme/v1/web")) {
    const isDetail = u.includes("/aweme/v1/web/aweme/detail/");
    if (isDetail) console.log(">>> DETAIL response:", u.slice(0, 160));
    else console.log(">>> aweme web response:", u.slice(0, 160));
    try {
      const t = resp.headers()["content-type"] || "";
      if (t.includes("json")) {
        const data = await resp.json();
        if (isDetail) {
          const aw = data?.aweme_detail || data?.aweme || null;
          console.log("    detail keys:", data ? Object.keys(data) : data);
          if (aw) {
            console.log("    aweme_id:", aw.aweme_id, "desc:", (aw.desc || "").slice(0, 50));
            console.log("    author uid:", aw.author?.uid, "nickname:", aw.author?.nickname);
            console.log("    video keys:", aw.video ? Object.keys(aw.video) : "none");
            console.log("    cover.url_list:", aw.video?.cover?.url_list);
            const bt = Array.isArray(aw.video?.big_thumbs) ? aw.video.big_thumbs : [];
            console.log("    big_thumbs len:", bt.length);
            bt.slice(0, 5).forEach((b) => console.log("      ", b.img_urls));
          } else {
            console.log("    no aweme_detail in keys");
          }
        } else if (Array.isArray(data?.aweme_list)) {
          console.log("    aweme_list:", data.aweme_list.length);
          for (const item of data.aweme_list.slice(0, 3)) {
            console.log("      item aweme_id:", item?.aweme_id, "desc:", (item?.desc || "").slice(0, 40));
            if (item?.video) {
              console.log("      video keys:", Object.keys(item.video));
              console.log("      cover.url_list:", item.video?.cover?.url_list);
              console.log("      big_thumbs len:", Array.isArray(item.video?.big_thumbs) ? item.video.big_thumbs.length : "n/a");
            }
          }
        }
      }
    } catch (e) {
      console.log("    parse err:", e.message);
    }
  }
});

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
console.log("[goto] video url done:", page.url());
await new Promise((r) => setTimeout(r, 3000));

// dump all /user/ links and anchors to understand DOM
const links = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") || "";
    if (href.includes("/user/")) out.push({ href: href.slice(0, 80), text: (a.textContent || "").slice(0, 30), cls: a.className.slice(0, 60) });
  });
  return out.slice(0, 15);
});
console.log("[dom] user links:");
links.forEach((l) => console.log("   ", l));

const modal = await page.evaluate(() => {
  const params = new URLSearchParams(window.location.search);
  return params.get("modal_id");
});
console.log("[url] modal_id param:", modal);

// dump account-name related elements to find the author's userId
const acc = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('[data-e2e]').forEach((el) => {
    const e2e = el.getAttribute("data-e2e") || "";
    if (e2e.includes("nickname") || e2e.includes("account")) {
      const a = el.querySelector("a[href]");
      out.push({
        e2e,
        cls: el.className.slice(0, 80),
        href: a ? a.getAttribute("href") || "" : "",
        text: (el.textContent || "").slice(0, 40),
      });
    }
  });
  // all links anywhere
  document.querySelectorAll("a[href*='/user/']").forEach((a) => {
    out.push({ href: a.getAttribute("href"), cls: a.className.slice(0, 80) });
  });
  return out;
});
console.log("[dom] account-name/nickname elems:");
acc.forEach((l) => console.log("   ", JSON.stringify(l)));

const userId = await page.evaluate(() => {
  const a = document.querySelector('a[href*="/user/"]');
  const href = a ? a.getAttribute("href") || "" : "";
  const m = href.match(/\/user\/([^/?]+)/);
  return m ? m[1] : null;
});
const videoId = modal || (await page.evaluate(() => {
  const m = window.location.href.match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}));
console.log("[ids] userId:", userId, "videoId:", videoId);

if (userId && videoId) {
  try {
    await page.goto(`https://www.douyin.com/user/${userId}?modal_id=${videoId}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    console.log("[goto] user page:", page.url());
  } catch (e) {
    console.log("[goto] user page failed/timeout:", e.message.slice(0, 120));
  }
  await new Promise((r) => setTimeout(r, 3000));

  // click "我知道了" if present
  try {
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const target = buttons.find((b) =>
        (b.textContent || "").includes("我知道了")
      );
      if (target) {
        target.click();
        return true;
      }
      return false;
    });
    if (clicked) {
      console.log("[dialog] clicked 我知道了");
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch {}

  // click account-name
  const sel = 'div.account-name.userAccountTextHover[data-e2e="feed-video-nickname"]';
  try {
    await page.waitForSelector(sel, { timeout: 10000 });
    await page.click(sel);
    console.log("[click] account-name clicked");
  } catch (e) {
    console.log("[click] account-name NOT found/failed:", e.message.slice(0, 120));
  }

  await new Promise((r) => setTimeout(r, 8000));

  // DOM snapshot of images
  const imgs = await page.evaluate(() => {
    const decode = (s) => s.replace(/&amp;/g, "&");
    const out = [];
    const seen = new Set();
    document.querySelectorAll("img[src]").forEach((el) => {
      const s = decode(el.getAttribute("src") || "");
      if (s.startsWith("http") && !seen.has(s)) {
        seen.add(s);
        out.push(s.slice(0, 120));
      }
    });
    return out;
  });
  console.log("[dom] img srcs (%d):", imgs.length);
  imgs.slice(0, 20).forEach((s) => console.log("   ", s));
}

await browser.disconnect();
console.log("[done]");