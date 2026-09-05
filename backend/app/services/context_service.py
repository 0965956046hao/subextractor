import concurrent.futures
import json
import logging
from pathlib import Path

from app.config import settings
from app.services.job_utils import JobCancelled
from app.services.retry_utils import (
    gemini_retry,
    configured_gemini_keys,
    _next_key,
    genai_generate_content_factory,
    gemini_model_chain,
    raise_if_gemini_cancelled,
    _is_retryable,
    _sleep_interruptible,
)

logger = logging.getLogger(__name__)

_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
)

VOICE_CATALOG_PATH = Path(__file__).resolve().parent.parent.parent.parent / "capcut-tts-api" / "Voice.json"

# Map our target-language codes ("vi"/"en"/"zh"...) to CapCut voice catalog lang
# codes ("vi-VN"/"en-US"/"zh-CN"...). Voices shown as suggestions must match the
# language the video is being dubbed into.
TARGET_LANG_TO_VOICE_LANG = {
    "vi": "vi-VN",
    "en": "en-US",
    "zh": "zh-CN",
    "ja": "ja-JP",
    "ko": "ko-KR",
    "th": "th-TH",
    "fr": "fr-FR",
    "es": "es-ES",
    "de": "de-DE",
    "pt": "pt-BR",
    "id": "id-ID",
}


def _voice_lang_code(target_lang: str) -> str:
    """Translate our target-language code to the CapCut catalog lang code."""
    return TARGET_LANG_TO_VOICE_LANG.get((target_lang or "vi").lower(), "vi-VN")


def _load_capcut_voice_catalog(target_lang: str = "vi") -> str:
    """Load the CapCut voice catalog for a target language as a formatted list.

    Chỉ lấy các giọng thuộc ngôn ngữ đích (vd tiếng Việt → lang "vi-VN",
    tiếng Anh → "en-US") để phần gợi ý giọng lồng tiếng chọn đúng giọng.
    """
    lang_code = _voice_lang_code(target_lang)
    try:
        data = json.loads(VOICE_CATALOG_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        logger.debug("Không đọc được Voice.json (%s)", e)
        return ""
    voices = [v for v in data if v.get("lang") == lang_code and v.get("display_name")]
    if not voices:
        logger.debug("Không có giọng CapCut cho ngôn ngữ %s (%s)", target_lang, lang_code)
        return ""
    lines = [f"- {v['voice_type']} ({v['display_name']})" for v in voices]
    return "\n".join(lines)


def _load_capcut_voice_display_map(target_lang: str = "vi") -> dict[str, str]:
    """Return {voice_type: display_name} for the CapCut catalog of a target language."""
    lang_code = _voice_lang_code(target_lang)
    try:
        data = json.loads(VOICE_CATALOG_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        logger.debug("Không đọc được Voice.json (%s)", e)
        return {}
    return {
        v["voice_type"]: v["display_name"]
        for v in data
        if v.get("lang") == lang_code and v.get("display_name") and v.get("voice_type")
    }

CONTEXT_DIR_NAME = "context"
CONTEXT_FILE_NAME = "context.txt"
FILES_INDEX_NAME = "gemini_files.json"
SHARE_TEXT_NAME = "share_text.txt"
TRANSLATION_CONTEXT_NAME = "translation_context.txt"


def _context_path(video_id: str) -> Path:
    return settings.temp_dir / CONTEXT_DIR_NAME / video_id / CONTEXT_FILE_NAME


def _share_text_path(video_id: str) -> Path:
    return settings.temp_dir / CONTEXT_DIR_NAME / video_id / SHARE_TEXT_NAME


def _files_index_path(video_id: str) -> Path:
    return settings.temp_dir / CONTEXT_DIR_NAME / video_id / FILES_INDEX_NAME


def _translation_context_path(video_id: str) -> Path:
    return settings.temp_dir / CONTEXT_DIR_NAME / video_id / TRANSLATION_CONTEXT_NAME


def _context_images_dir(video_id: str) -> Path:
    return settings.temp_dir / CONTEXT_DIR_NAME / video_id / "context_images"


def _thumbnail_file(video_id: str) -> Path:
    return settings.temp_dir / CONTEXT_DIR_NAME / video_id / "thumbnail.jpg"


def _merge_context_dir(video_id: str) -> Path | None:
    """Return the merge-step context dir (merged/{merge_id}_context) if known.

    merge_id được lưu trong videos/{video_id}/meta.json dưới khóa source_merge_id.
    """
    meta = settings.temp_dir / "videos" / video_id / "meta.json"
    if not meta.exists():
        return None
    try:
        data = json.loads(meta.read_text(encoding="utf-8"))
    except Exception:
        return None
    merge_id = data.get("source_merge_id")
    if not merge_id:
        return None
    d = settings.temp_dir / "merged" / f"{merge_id}_context" / "context_images"
    return d if d.exists() else None


def _context_image_paths(video_id: str) -> list[Path]:
    """Return the local context images (big thumbs) for this video.

    Ưu tiên đọc trực tiếp từ thư mục context_images của bước merge
    (merged/{merge_id}_context/context_images), fallback về thư mục đã copy
    vào context/{video_id}/context_images.
    """
    d = _merge_context_dir(video_id)
    if d is not None:
        return sorted(d.glob("*.jpg"))
    d = _context_images_dir(video_id)
    if not d.exists():
        return []
    return sorted(d.glob("*.jpg"))


def load_translation_context(video_id: str) -> str | None:
    """Load the accumulated translation context (built patch-by-patch)."""
    p = _translation_context_path(video_id)
    if p.exists():
        return p.read_text(encoding="utf-8").strip()
    return None


def append_translation_context(video_id: str, note: str) -> None:
    """Append a patch context note to the translation-context file."""
    p = _translation_context_path(video_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    prev = load_translation_context(video_id)
    content = f"{prev}\n\n{note}" if prev else note
    p.write_text(content, encoding="utf-8")


def _save_files_index(video_id: str, api_key: str, file_names: list[str]):
    p = _files_index_path(video_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"api_key": api_key, "files": file_names}), encoding="utf-8")


def _load_files_index(video_id: str) -> tuple[str | None, list[str]]:
    """Return (api_key, file_names). Handles legacy list format (key unknown)."""
    p = _files_index_path(video_id)
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return None, []
        if isinstance(data, dict):
            return data.get("api_key"), (data.get("files") or [])
        if isinstance(data, list):
            return None, data
    return None, []


def _read_user_config() -> dict:
    import json
    cf = settings.temp_dir / "user_config.json"
    if cf.exists():
        try:
            return json.loads(cf.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def load_video_context(video_id: str) -> str | None:
    """Load previously generated video context, if it exists."""
    """Load previously generated video context, if it exists."""
    cp = _context_path(video_id)
    if cp.exists():
        return cp.read_text(encoding="utf-8").strip()
    return None


def save_share_text(video_id: str, text: str) -> None:
    """Persist the raw pasted share text so context generation can use it."""
    p = _share_text_path(video_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def load_share_text(video_id: str) -> str | None:
    """Load the saved share text, if any."""
    p = _share_text_path(video_id)
    if p.exists():
        try:
            return p.read_text(encoding="utf-8").strip()
        except Exception:
            return None
    return None


def _thumbnail_file(video_id: str) -> Path:
    return settings.temp_dir / CONTEXT_DIR_NAME / video_id / "thumbnail.jpg"


def load_thumbnail_file(video_id: str) -> Path | None:
    """Return the local thumbnail image downloaded during merge, if any."""
    p = _thumbnail_file(video_id)
    return p if p.exists() else None


def generate_video_context(video_id: str, target_lang: str = "vi") -> str | None:
    """Upload context images (big thumbs) to Gemini File Store, then call Vision.

    Ảnh ngữ cảnh (big_thumbs) đã được tải về song song với video+audio ở bước
    merge và copy vào context/{video_id}/context_images/. Đọc trực tiếp các file
    này, không tạo big_thumbs.json nữa.
    """
    local_images = _context_image_paths(video_id)
    if not local_images:
        logger.info("No context images for %s, skipping context generation", video_id)
        return None

    logger.info("Using %d local context images for %s", len(local_images), video_id)

    try:
        from google import genai
    except ImportError:
        logger.warning("google-genai not installed, skipping context generation")
        return None

    keys = configured_gemini_keys()
    if not keys:
        logger.warning("GEMINI_API_KEY not set, skipping context generation")
        return None

    # Use ONE key for the entire operation (upload + generate). File Store is
    # key-scoped: a file uploaded with key A is 403 when read by key B.
    api_key = _next_key(keys)
    client = genai.Client(api_key=api_key)

    # Check if files already uploaded for this video_id AND by this key —
    # reuse to avoid spam. Files uploaded by a different key must be re-uploaded.
    stored_key, existing_names = _load_files_index(video_id)
    uploaded_files = []

    if existing_names and stored_key == api_key:
        logger.info("Found %d files in File Store for %s, reusing", len(existing_names), video_id)
        for name in existing_names:
            try:
                gf = gemini_retry(client.files.get)(name=name)
                uploaded_files.append(gf)
            except Exception:
                logger.debug("File %s gone from store", name)
        if uploaded_files:
            logger.info("Reused %d/%d files", len(uploaded_files), len(existing_names))

    if not uploaded_files:
        # Upload fresh — concurrently (up to 8 at a time)
        def _upload_one(f):
            try:
                gf = gemini_retry(client.files.upload)(file=str(f))
                logger.info("Uploaded: %s (%s)", gf.name, f.name)
                return gf
            except Exception as e:
                logger.warning("Upload failed %s: %s", f.name, e)
                return None

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(_upload_one, local_images))

        uploaded_files = [r for r in results if r is not None]

        if not uploaded_files:
            logger.warning("No images uploaded for %s", video_id)
            return None

        _save_files_index(video_id, api_key, [gf.name for gf in uploaded_files])

    # Send all File Store files to Gemini Vision in ONE request
    share_hint = load_share_text(video_id)
    hint_text = ""
    if share_hint:
        hint_text = (
            f"\n\nSHARE TEXT (nội dung user dán kèm link, có thể chứa tiêu đề/mô tả video):\n"
            f"{share_hint}\n"
            "Dùng thông tin này để xác định chính xác tiêu đề, nội dung và bối cảnh video."
        )

    try:
        voice_catalog = _load_capcut_voice_catalog(target_lang)
        voice_instruction = ""
        if voice_catalog:
            voice_instruction = (
                "\n\nDANH SÁCH GIỌNG ĐỌC CAPCUT CÓ SẴN (voice_type + tên hiển thị):\n"
                f"{voice_catalog}\n\n"
                "Ở cuối phần mô tả, thêm mục 'GIỌNG LỒNG TIẾNG ĐỀ XUẤT' gồm các dòng "
                "'- Tên nhân vật: voice_type (tên hiển thị)' — chọn giọng phù hợp NHẤT cho từng "
                "nhân vật dựa trên giới tính, độ tuổi, tính cách và giọng nói đã mô tả ở trên. "
                "MỖI NHÂN VẬT CHỈ GÁN 1 GIỌNG DUY NHẤT. "
                "Chỉ chọn từ danh sách có sẵn, không tự đặt tên giọng mới."
            )
        # Dùng Chat API (client.chats.create().send_message) thay vì
        # models.generate_content để tránh cảnh báo AFC của SDK. Retry giữ
        # nguyên qua gemini_retry, nhưng KHÔNG xoay key (file trên File Store
        # khóa theo api_key đã upload → key khác sẽ 403).
        prompt = (
            f"Analyze these {len(uploaded_files)} context images from video '{video_id}'. "
            "Synthesize ALL images together to understand the full video context. "
            "Describe in Vietnamese (4-6 sentences), including:\n"
            "- Content type (phim cổ trang / hiện đại / hoạt hình / tài liệu / tutorial...)\n"
            "- Time period and setting (bối cảnh lịch sử, không gian)\n"
            "- Main characters: count, gender (nam/nữ), estimated age, voice characteristics "
            "(cao/thấp, trầm/thanh, tốc độ nói, giọng già/trẻ), personality, relationships\n"
            "- How characters address each other (xưng hô: huynh-đệ, anh-em, ngài-tiểu nhân, bạn-cậu...)\n"
            "- Overall tone (nghiêm túc / hài hước / hành động / lãng mạn...)\n"
            "- Any notable visual style, costumes, or recurring text on screen\n\n"
            "Mô tả chi tiết GIỌNG NÓI của từng nhân vật chính (giới tính, độ tuổi, âm vực, "
            "tính cách thể hiện qua giọng) để phục vụ việc chọn giọng đọc lồng tiếng phù hợp."
            "Be specific and detailed. This context will be used to improve subtitle translation accuracy."
            + hint_text
            + voice_instruction
        )

        # Reuse the SAME client/key used for the File-Store upload above.
        # Gemini File Store is key-scoped, so the chat call MUST use the same
        # api_key (rotating here would 403 on the uploaded files). Creating a
        # throwaway client inside a factory and returning its bound method lets
        # the client be garbage-collected before the request is sent, raising
        # "Cannot send a request, as the client has been closed" (see
        # retry_utils.genai_generate_content_factory docstring).
        # Model fallback: lỗi retryable (429/503/5xx) thì đổi sang model kế
        # tiếp (tối đa 2 lượt mỗi model); hết chuỗi mới bỏ qua như cũ.
        response = None
        last_err: Exception | None = None
        chain = gemini_model_chain(settings.gemini_model)
        logger.info(
            "Context: model %s%s",
            chain[0],
            f" (+{len(chain) - 1} fallbacks)" if len(chain) > 1 else "",
        )
        for model in chain:
            raise_if_gemini_cancelled()
            chat = client.chats.create(model=model)
            for attempt in range(2):
                try:
                    response = chat.send_message([*uploaded_files, prompt])
                    break
                except JobCancelled:
                    raise
                except Exception as e:
                    last_err = e
                    if not _is_retryable(e):
                        raise
                    logger.info(
                        "Context model %s failed (attempt %d/2): %s",
                        model, attempt + 1, e,
                    )
                    if attempt == 0:
                        _sleep_interruptible(3)
            if response is not None:
                if model != settings.gemini_model:
                    logger.info("Context fell back to model %s", model)
                break
            logger.info("Context switching to next model after %s failed", model)
        if response is None:
            raise last_err or RuntimeError("Context generation failed on all models")

        context = response.text.strip()
    except JobCancelled:
        raise
    except Exception as e:
        logger.exception("Gemini Vision context generation failed: %s", e)
        return None

    if not context:
        return None

    cp = _context_path(video_id)
    cp.parent.mkdir(parents=True, exist_ok=True)
    cp.write_text(context, encoding="utf-8")
    logger.info("Video context saved for %s: %s", video_id, context[:120])
    return context
