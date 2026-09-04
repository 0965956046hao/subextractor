import re

import cv2
import numpy as np

_HEX_RE = re.compile(r"^#?([0-9a-fA-F]{6})$")


def hex_to_rgb(hex_str: str) -> tuple[int, int, int]:
    """#RRGGBB -> (R,G,B), fallback #FFFFFF on invalid."""
    m = _HEX_RE.match(hex_str.strip() if hex_str else "")
    if not m:
        return (255, 255, 255)
    h = m.group(1)
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def apply_color_mask(crop: np.ndarray, color_hex: str, tolerance: int) -> np.ndarray:
    """Keep pixels near `color_hex` within `tolerance` (Euclidean RGB distance).

    Pixels outside tolerance are filled with contrasting background (black if
    target is light, white if target is dark) so the kept text stays visible
    for Vision/RapidOCR.
    """
    if crop.size == 0:
        return crop
    tolerance = max(0, min(100, int(tolerance)))
    r, g, b = hex_to_rgb(color_hex)
    # BGR order for OpenCV
    target = np.array([b, g, r], dtype=np.int16)
    # Euclidean distance per pixel in RGB space (0..441)
    diff = crop.astype(np.int16) - target
    dist = np.sqrt(np.sum(diff.astype(np.float32) ** 2, axis=2))
    mask = dist <= tolerance  # H x W bool

    # Contrasting background: luma of target
    luma = 0.299 * r + 0.587 * g + 0.114 * b
    bg_val = 0 if luma > 128 else 255
    bg = np.full_like(crop, bg_val)

    # Keep original where mask true, else background
    result = np.where(mask[:, :, None], crop, bg)
    return result.astype(np.uint8)
