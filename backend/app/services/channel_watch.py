"""Background worker: periodically scan Douyin watchlist channels (configured
at the frontend /channels page) for new videos and save them under temp/.

Flow per cycle (only when `channel_watch_enabled` in user_config):
1. GET {frontend_url}/api/channels → watchlist [{id, url, name}].
2. For each channel (sequentially — the FE scan drives one headless Chrome):
   POST {frontend_url}/api/channels/scan {url, since: last_create_time}.
3. Save new videos to temp/channel_watch/{channel_id}.json and update
   temp/channel_watch/state.json (last_create_time per channel).
   temp/channel_watch/latest.json aggregates the newest videos everywhere.

Enable/disable: Settings page toggle → user_config `channel_watch_enabled`
(checked every minute, so no restart needed).
Interval: env STE_channel_watch_interval_minutes (default 30).
"""

import asyncio
import json
import logging
import time

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

WATCH_DIR = settings.temp_dir / "channel_watch"
STATE_FILE = WATCH_DIR / "state.json"
LATEST_FILE = WATCH_DIR / "latest.json"
COVERS_DIR = WATCH_DIR / "covers"

# First scan per channel: save at most this many newest videos as baseline
# so the files are useful immediately without flooding.
FIRST_RUN_KEEP = 5
# Max Telegram notifications per cycle (first runs can backfill many).
NOTIFY_MAX_PER_CYCLE = 10

_COVER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
)

_last_run: float | None = None
_last_error: str | None = None


def _read_user_config() -> dict:
    from app.routers.config_router import _read_config

    try:
        return _read_config()
    except Exception:
        return {}


def is_enabled() -> bool:
    return bool(_read_user_config().get("channel_watch_enabled", False))


def interval_seconds() -> int:
    try:
        minutes = int(getattr(settings, "channel_watch_interval_minutes", 30))
    except (TypeError, ValueError):
        minutes = 30
    return max(5 * 60, minutes * 60)


def _load_state() -> dict:
    if STATE_FILE.exists():
        try:
            data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}
    return {}


def _save_state(state: dict) -> None:
    WATCH_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def _frontend_base() -> str:
    return (settings.frontend_url or "http://localhost:3000").rstrip("/")


def _since_date_ts(since_date: str) -> int:
    """Convert YYYY-MM-DD to unix timestamp (0 if empty/invalid)."""
    import datetime

    s = (since_date or "").strip()
    if not s:
        return 0
    try:
        dt = datetime.datetime.strptime(s, "%Y-%m-%d")
        return int(dt.timestamp())
    except ValueError:
        return 0


def _fetch_channels(client: httpx.Client) -> list[dict]:
    r = client.get(f"{_frontend_base()}/api/channels", timeout=30)
    r.raise_for_status()
    data = r.json()
    channels = data.get("channels") if isinstance(data, dict) else None
    return channels if isinstance(channels, list) else []


def _scan_channel(client: httpx.Client, url: str, since: int) -> dict:
    r = client.post(
        f"{_frontend_base()}/api/channels/scan",
        json={"url": url, "since": since},
        timeout=300,
    )
    r.raise_for_status()
    data = r.json()
    return data if isinstance(data, dict) else {}


def _slim_video(v: dict, channel: dict) -> dict:
    video = v.get("video") or {}
    cover = (video.get("cover") or {}).get("url_list") or []
    stats = v.get("statistics") or {}
    return {
        "aweme_id": v.get("aweme_id", ""),
        "desc": v.get("desc", ""),
        "create_time": v.get("create_time", 0),
        "share_url": v.get("share_url") or v.get("share_link_desc") or "",
        "cover": cover[0] if cover else "",
        "duration": video.get("duration"),
        "play_count": stats.get("play_count"),
        "digg_count": stats.get("digg_count"),
        "channel_id": channel.get("id", ""),
        "channel_name": channel.get("name", "") or v.get("author", {}).get("nickname", ""),
        "channel_url": channel.get("url", ""),
        "scanned_at": int(time.time()),
    }


def scan_once() -> dict:
    """Scan all watchlist channels once. Returns summary {channels, new_videos}."""
    global _last_run, _last_error
    WATCH_DIR.mkdir(parents=True, exist_ok=True)
    state = _load_state()
    summary: dict = {"channels": 0, "new_videos": 0, "errors": [], "new_items": []}

    with httpx.Client() as client:
        try:
            channels = _fetch_channels(client)
        except Exception as e:
            _last_error = f"Không lấy được watchlist: {e}"
            logger.warning("channel-watch: %s", _last_error)
            summary["errors"].append(_last_error)
            return summary

        for ch in channels:
            cid = str(ch.get("id") or ch.get("url"))
            url = (ch.get("url") or "").strip()
            if not url:
                continue
            summary["channels"] += 1
            since = int((state.get(cid) or {}).get("last_create_time", 0))
            # Ngày riêng của kênh (Settings) làm mốc sàn: không bao giờ lấy
            # video cũ hơn ngày này, kể cả state chưa có.
            floor = _since_date_ts(str(ch.get("since_date") or ""))
            if floor > since:
                since = floor
            try:
                result = _scan_channel(client, url, since)
            except Exception as e:
                msg = f"{ch.get('name') or url}: {e}"
                logger.warning("channel-watch scan failed: %s", msg)
                summary["errors"].append(msg)
                continue
            videos = result.get("videos") or []
            if not videos:
                logger.info("channel-watch: %s — không có video mới", ch.get("name") or url)
                continue
            slim = [_slim_video(v, ch) for v in videos if v.get("aweme_id")]
            if not slim:
                continue
            if cid not in state:
                # Lần quét đầu: chỉ giữ N video mới nhất làm baseline.
                slim = sorted(slim, key=lambda x: x["create_time"], reverse=True)[:FIRST_RUN_KEEP]
            slim.sort(key=lambda x: x["create_time"], reverse=True)
            out_path = WATCH_DIR / f"{ch.get('id', cid)}.json"
            out_path.write_text(
                json.dumps(
                    {"channel": {"id": ch.get("id"), "name": ch.get("name"), "url": url},
                     "videos": slim, "scanned_at": int(time.time())},
                    ensure_ascii=False, indent=2,
                ),
                encoding="utf-8",
            )
            newest = max(v["create_time"] for v in slim)
            state[cid] = {"last_create_time": max(newest, since), "name": ch.get("name", "")}
            summary["new_videos"] += len(slim)
            summary["new_items"].extend(slim)
            logger.info("channel-watch: %s — %d video mới", ch.get("name") or url, len(slim))

    _save_state(state)
    _rebuild_latest()
    _last_run = time.time()
    _last_error = None if not summary["errors"] else "; ".join(summary["errors"][:3])
    return summary


def _rebuild_latest(limit: int = 50) -> None:
    """Aggregate newest videos across channels into latest.json."""
    all_videos: list[dict] = []
    for fp in WATCH_DIR.glob("*.json"):
        if fp.name in ("state.json", "latest.json"):
            continue
        try:
            data = json.loads(fp.read_text(encoding="utf-8"))
            videos = data.get("videos") if isinstance(data, dict) else None
            if isinstance(videos, list):
                all_videos.extend(videos)
        except Exception:
            continue
    all_videos.sort(key=lambda x: x.get("create_time", 0), reverse=True)
    LATEST_FILE.write_text(
        json.dumps({"videos": all_videos[:limit], "updated_at": int(time.time())},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def read_status() -> dict:
    """Status snapshot for GET /api/channel-watch."""
    state = _load_state()
    channels = []
    for fp in WATCH_DIR.glob("*.json"):
        if fp.name in ("state.json", "latest.json"):
            continue
        try:
            data = json.loads(fp.read_text(encoding="utf-8"))
        except Exception:
            continue
        videos = data.get("videos") if isinstance(data, dict) else []
        if not isinstance(videos, list):
            videos = []
        ch = data.get("channel") if isinstance(data, dict) else {}
        try:
            scanned_at = int(fp.stat().st_mtime)
        except Exception:
            scanned_at = 0
        channels.append({
            "id": (ch or {}).get("id", fp.stem),
            "name": (ch or {}).get("name", ""),
            "url": (ch or {}).get("url", ""),
            "video_count": len(videos),
            "newest_desc": (videos[0].get("desc", "")[:80] if videos else ""),
            "newest_time": (videos[0].get("create_time", 0) if videos else 0),
            "scanned_at": scanned_at,
            "videos": videos[:10],
        })
    channels.sort(key=lambda c: c["newest_time"], reverse=True)
    return {
        "enabled": is_enabled(),
        "interval_minutes": interval_seconds() // 60,
        "last_run": _last_run,
        "last_error": _last_error,
        "channels": channels,
    }


async def watch_loop() -> None:
    """Background loop: scan every interval while enabled (checked minutely)."""
    logger.info("channel-watch loop started")
    while True:
        try:
            if is_enabled():
                loop = asyncio.get_event_loop()
                summary = await loop.run_in_executor(None, scan_once)
                logger.info("channel-watch cycle done: %s", {k: v for k, v in summary.items() if k != "new_items"})
                await notify_new_videos(summary.get("new_items") or [])
            # Sleep in 60s slices so toggling off/on reacts within a minute.
            waited = 0
            target = interval_seconds()
            while waited < target:
                await asyncio.sleep(min(60, target - waited))
                waited += 60
                if not is_enabled():
                    break
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("channel-watch loop error")
            await asyncio.sleep(60)


def _fmt_num(n) -> str:
    try:
        n = int(n)
    except (TypeError, ValueError):
        return "—"
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def _download_cover(client: httpx.Client, url: str, aweme_id: str) -> str | None:
    """Download cover to temp; return local path or None."""
    if not url:
        return None
    try:
        COVERS_DIR.mkdir(parents=True, exist_ok=True)
        dest = COVERS_DIR / f"{aweme_id}.jpg"
        if dest.exists() and dest.stat().st_size > 0:
            return str(dest)
        r = client.get(
            url,
            timeout=60,
            headers={"User-Agent": _COVER_UA, "Referer": "https://www.douyin.com/"},
        )
        r.raise_for_status()
        tmp = dest.with_suffix(".tmp")
        tmp.write_bytes(r.content)
        tmp.replace(dest)
        return str(dest)
    except Exception as e:
        logger.debug("channel-watch cover download failed: %s", e)
        return None


def _video_caption(v: dict) -> str:
    desc = (v.get("desc") or "").strip()
    if len(desc) > 200:
        desc = desc[:200] + "…"
    lines = [
        f"🎬 <b>{v.get('channel_name') or 'Kênh mới'}</b>",
        f"📌 {desc or '(không có mô tả)'}",
        f"👁 {_fmt_num(v.get('play_count'))}   ❤️ {_fmt_num(v.get('digg_count'))}",
    ]
    if v.get("share_url"):
        lines.append(f"🔗 {v['share_url']}")
    return "\n".join(lines)


async def notify_new_videos(items: list[dict]) -> int:
    """Telegram-broadcast new videos (cover + channel + title + Subtitle btn)."""
    from app.services.telegram_bot import cwsub_keyboard, register_cwsub
    from app.services.telegram_service import telegram_service

    if not items or not telegram_service.has_connected_chats():
        return 0
    items = sorted(items, key=lambda x: x.get("create_time", 0), reverse=True)
    omitted = max(0, len(items) - NOTIFY_MAX_PER_CYCLE)
    sent = 0
    with httpx.Client() as client:
        for v in items[:NOTIFY_MAX_PER_CYCLE]:
            caption = _video_caption(v)
            link = v.get("share_url") or ""
            key = register_cwsub(link, v.get("channel_name") or "", v.get("desc") or "")
            keyboard = cwsub_keyboard(key)
            cover_path = await asyncio.get_event_loop().run_in_executor(
                None, _download_cover, client, v.get("cover") or "", v.get("aweme_id", "x"),
            )
            try:
                if cover_path:
                    ok = await telegram_service.broadcast_photo_with_buttons(cover_path, caption, keyboard)
                else:
                    ok = False
                    for cid in telegram_service.connected_chat_ids():
                        mid = await telegram_service.send_message_with_keyboard(cid, caption, keyboard)
                        ok = ok or mid is not None
                if ok:
                    sent += 1
            except Exception:
                logger.exception("channel-watch notify failed")
    if omitted:
        try:
            await telegram_service.broadcast(f"…và {omitted} video mới khác (xem temp/channel_watch/latest.json)")
        except Exception:
            pass
    logger.info("channel-watch notified %d video(s)", sent)
    return sent


async def scan_and_notify() -> dict:
    """One scan cycle + Telegram notify (shared by loop and manual trigger)."""
    loop = asyncio.get_event_loop()
    summary = await loop.run_in_executor(None, scan_once)
    await notify_new_videos(summary.get("new_items") or [])
    return {k: v for k, v in summary.items() if k != "new_items"}
