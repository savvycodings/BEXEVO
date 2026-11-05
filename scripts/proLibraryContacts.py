"""Measure each pro-library clip's contact frame the same way train_modal_app does.

YOLO COCO class 32 is the ball and 38 is the racket. The contact frame is the
median frame where both are visible. Writes contacts.json next to the clips
and the copy the server ships as a fallback.
"""
import json
import sys
from pathlib import Path

import cv2
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parents[1] / "uploads" / "pro-library"
SHIPPED = Path(__file__).resolve().parents[1] / "src" / "technique" / "proLibraryContacts.json"
EXTS = {".mp4", ".mov", ".MP4", ".MOV"}


def contact_frame(model, video: Path) -> int | None:
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        return None
    both = []
    index = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        # Every frame. These clips are short, and the contact window is a few frames wide.
        result = model(frame, verbose=False, classes=[32, 38], conf=0.01, iou=0.45, imgsz=320, max_det=24)[0]
        labels = set()
        if result.boxes is not None:
            for cls in result.boxes.cls.tolist():
                labels.add(int(cls))
        if 32 in labels and 38 in labels:
            both.append(index)
        index += 1
    cap.release()
    if not both:
        return None
    return both[len(both) // 2]


def main() -> None:
    model = YOLO("yolov8n.pt")
    contacts = {}
    if SHIPPED.exists():
        try:
            contacts.update(json.loads(SHIPPED.read_text(encoding="utf-8")))
        except json.JSONDecodeError:
            pass
    videos = sorted(p for p in ROOT.rglob("*") if p.suffix in EXTS)
    for video in videos:
        clip_id = f"{video.parent.name}:{video.stem}"
        if isinstance(contacts.get(clip_id), int):
            print(f"keep {clip_id} {contacts[clip_id]}", flush=True)
            continue
        frame = contact_frame(model, video)
        print(f"{clip_id} {frame}", flush=True)
        if frame is not None:
            contacts[clip_id] = frame
            text = json.dumps(contacts, indent=2) + "\n"
            (ROOT / "contacts.json").write_text(text, encoding="utf-8")
            SHIPPED.write_text(text, encoding="utf-8")
    missing = [f"{p.parent.name}:{p.stem}" for p in videos if not isinstance(contacts.get(f"{p.parent.name}:{p.stem}"), int)]
    print(json.dumps({"measured": len(contacts), "missing": missing}))
    if missing:
        sys.exit(2)


if __name__ == "__main__":
    main()
