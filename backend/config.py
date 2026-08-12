import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TEMP_DIR = os.path.join(BASE_DIR, "temp")

EXTRACT_FPS = 10
OCR_LANG = "ch"
SIMILARITY_THRESHOLD = 0.85

MAX_UPLOAD_SIZE = 500 * 1024 * 1024

os.makedirs(TEMP_DIR, exist_ok=True)
os.makedirs(os.path.join(TEMP_DIR, "videos"), exist_ok=True)
os.makedirs(os.path.join(TEMP_DIR, "frames"), exist_ok=True)
os.makedirs(os.path.join(TEMP_DIR, "srt"), exist_ok=True)
