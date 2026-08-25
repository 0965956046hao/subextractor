# Task 1 Report: Extend TelegramService with InlineKeyboard Methods

**Status:** DONE  
**Commit:** `b8cb18d` — `feat(telegram): add InlineKeyboard methods and callback routing`

## What was done

Extended `backend/app/services/telegram_service.py` with InlineKeyboard support and callback query routing, adding 5 new methods and modifying `_handle_update`.

### New methods added

| Method | Signature | Returns |
|--------|-----------|---------|
| `send_message_with_keyboard` | `(chat_id, text, keyboard, parse_mode="HTML")` | `int \| None` (message_id) |
| `edit_message` | `(chat_id, message_id, text, keyboard=None, parse_mode="HTML")` | `bool` |
| `answer_callback_query` | `(callback_query_id, text="", show_alert=False)` | `bool` |
| `register_callback_handler` | `(prefix, handler)` | `None` |
| `_handle_callback_query` | `(callback_query)` | `None` (internal) |

Plus `_handle_douyin_command` — a bridge method that lazily imports `telegram_bot` and delegates to `_handle_douyin()`.

### Callback routing architecture

- `self._callback_handlers: dict[str, callable]` stores prefix → handler mappings
- `_handle_callback_query` matches the **longest prefix** first (e.g. `douyin:config:` beats `douyin:`)
- `_handle_update` now checks for `callback_query` **before** `message` — callback queries take priority
- Unmatched callbacks get a no-op `answerCallbackQuery` to dismiss the spinner
- Handler errors are caught and the user sees a toast: "❌ Có lỗi xảy ra."

### Key design decisions

1. **Longest-prefix matching** — allows fine-grained handlers like `douyin:lang:` without blocking coarser `douyin:` handlers
2. **Lazy import of `telegram_bot`** — avoids circular imports; ImportError is caught and produces a user-friendly fallback message
3. **`keyboard=None` default in `edit_message`** — omits `reply_markup` from the API call when None, preserving the existing keyboard
4. **`show_alert` parameter** — supports both toast notifications and modal alerts from `answer_callback_query`

## Test summary

- ✅ `python -c "from app.services.telegram_service import TelegramService"` — clean import
- ✅ AST parse: all 26 methods verified present, no syntax errors
- ✅ New attributes: `_callback_handlers` initialized as empty dict in `__init__`
- No unit tests (none exist in the repo per AGENTS.md)

## Concerns

None. All methods follow existing patterns (httpx via `_get_http()`, `logger.warning()` for errors, `TELEGRAM_API` constant, async).
