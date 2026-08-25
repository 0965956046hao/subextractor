# Task 1: Extend TelegramService with InlineKeyboard Methods

## Context
This is the first task in building the Telegram Douyin bot feature. The existing `TelegramService` in `backend/app/services/telegram_service.py` handles polling, messaging, and video sending via raw httpx calls to Telegram Bot API. We need to add InlineKeyboard support for the config UI.

## Requirements
Add three new methods to `TelegramService`:

### 1. `send_message_with_keyboard(chat_id, text, keyboard, parse_mode="HTML") -> int | None`
- Sends a message with InlineKeyboard buttons
- Returns `message_id` on success, None on failure
- `keyboard` is `list[list[dict]]` — each inner list is a row of buttons
- Each button dict has `text` and `callback_data` keys

### 2. `edit_message(chat_id, message_id, text, keyboard=None, parse_mode="HTML") -> bool`
- Edits an existing message and optionally updates its InlineKeyboard
- Returns True on success
- Used to update ✅ marks when user clicks config buttons

### 3. `answer_callback_query(callback_query_id, text="", show_alert=False) -> bool`
- Answers an inline keyboard callback query to stop the loading spinner
- Returns True on success

### 4. Callback routing
- Add `_callback_handlers: dict[str, callable]` attribute (prefix → handler)
- Add `register_callback_handler(prefix, handler)` method
- Add `_handle_callback_query(callback_query)` method that routes by data prefix
- Modify `_handle_update()` to handle `callback_query` in addition to `message`
- Add `/douyin` command routing to `telegram_bot._handle_douyin()`

## Files
- Modify: `backend/app/services/telegram_service.py`

## Interfaces
- Produces: `send_message_with_keyboard()`, `edit_message()`, `answer_callback_query()`, `register_callback_handler()`

## Constraints
- No new Python dependencies
- Use existing httpx client pattern
- Follow existing code style (async methods, httpx, logging)
- All Telegram API calls go through the shared `_get_http()` client

## Report
Write your report to: `/Users/phantrongtinh/Documents/video/subextractor/.superpowers/sdd/task-1-report.md`
