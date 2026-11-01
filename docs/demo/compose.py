# Composites Grabbit's overlay windows onto the demo frame for the README (they can't be captured as one screen
# while the PC is locked, and composing keeps every pixel from the made-up demo page).
#   recording.png : the demo frame, dimmed outside a recorded area, red frame, Stop bar under it
#   hold.png      : the hold-to-record pill near the pointer
#   quick.png     : the quick-access card in the corner after a capture
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

root = Path(__file__).resolve().parent
parts = root / "out" / "parts"
out = root.parent / "screenshots"
frame = Image.open(root / "out" / "demo-4k.png").convert("RGBA")
W, H = frame.size


def shrink(img, width=1920):
    return img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)


def pointer(draw, x, y, s=1.5):
    pts = [(0, 0), (0, 25), (6, 19), (11, 30), (15, 28), (10, 18), (18, 18)]
    pts = [(x + px * s, y + py * s) for px, py in pts]
    draw.polygon(pts, fill="white", outline="black")


# Recording: area dimmed around, red border, bar centred under it.
rec = frame.copy()
ax, ay, aw, ah = 420, 300, 2400, 1380
dim = Image.new("RGBA", rec.size, (0, 0, 0, 0))
d = ImageDraw.Draw(dim)
d.rectangle([0, 0, W, H], fill=(0, 0, 0, 90))
d.rectangle([ax, ay, ax + aw, ay + ah], fill=(0, 0, 0, 0))
rec = Image.alpha_composite(rec, dim)
d = ImageDraw.Draw(rec)
for i in range(5):
    d.rectangle([ax - 5 + i, ay - 5 + i, ax + aw + 5 - i, ay + ah + 5 - i], outline=(255, 59, 48, 255))
bar = Image.open(parts / "recbar.png").convert("RGBA")
rec.alpha_composite(bar, (ax + (aw - bar.width) // 2, ay + ah + 20))
# Crop round the recorded area so the bar reads at README size.
rec.crop((ax - 260, ay - 200, ax + aw + 260, ay + ah + 240)).resize((1920, round(1920 * (ah + 440) / (aw + 520))), Image.LANCZOS).save(out / "recording.png")

# Hold to record: the pill by the pointer.
hold = frame.copy()
d = ImageDraw.Draw(hold)
px, py = 1500, 900
pointer(d, px, py, 2.2)
pill = Image.open(parts / "hint.png").convert("RGBA")
shadow = Image.new("RGBA", hold.size, (0, 0, 0, 0))
hold.alpha_composite(pill, (px + 40, py + 55))
shrink(hold).save(out / "hold.png")

# Quick access: the card in the bottom-right corner.
quick = frame.copy()
card = Image.open(parts / "quick.png").convert("RGBA")
quick.alpha_composite(card, (W - card.width - 45, H - card.height - 60))
crop = quick.crop((W - 1500, H - 1000, W, H))
crop.resize((1125, 750), Image.LANCZOS).save(out / "quick.png")
print("composed recording.png, hold.png, quick.png")
