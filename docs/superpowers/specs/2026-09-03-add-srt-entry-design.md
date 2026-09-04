# Add SRT Entry Feature

## Goal
Allow users to manually add a new subtitle entry to an existing SRT file via the TimelineCheckModal.

## User Flow
1. User opens TimelineCheckModal (timeline check step)
2. Clicks "+" button in the modal header
3. A small modal appears with form fields: Start time, End time, Text
4. Start/End times are pre-filled from current playhead position
5. User fills in text and submits
6. New entry is inserted, sorted by start time, re-indexed
7. Timeline and SRT list update immediately

## UI Design
- **Trigger**: "+" button next to "Kiểm tra risk" button in header
- **Form modal**: Small centered modal with:
  - Start time input (HH:MM:SS,ms format)
  - End time input (HH:MM:SS,ms format, default = start + 2s)
  - Text textarea
  - Cancel / Add buttons

## Technical Details
- **File**: `frontend/src/components/TimelineCheckModal.tsx`
- **State**: `showAddModal` (boolean)
- **Helper**: Reuse `secToSrt()` for display, add `parseSrtTime()` for parsing
- **Insert logic**: Push to entries array, sort by `start`, re-index all entries
- **Validation**: start < end, text non-empty, valid time format

## Scope
- Frontend only (no backend changes needed — `updateSrt` already handles full SRT content)
- Single file change: `TimelineCheckModal.tsx`
