# Contact sheets of the audit pictures: python sheet.py <dir> <pattern…> → <dir>/sheet-N.png (6 per sheet, labelled).
import glob, os, sys
from PIL import Image, ImageDraw

d = sys.argv[1]
files = sorted({f for pat in sys.argv[2:] for f in glob.glob(os.path.join(d, pat))})
W, H, COLS, ROWS = 960, 600, 2, 3
for n in range(0, len(files), COLS * ROWS):
    sheet = Image.new("RGB", (W * COLS, (H + 28) * ROWS), (120, 120, 120))
    g = ImageDraw.Draw(sheet)
    for i, f in enumerate(files[n:n + COLS * ROWS]):
        im = Image.open(f).convert("RGBA")
        im.thumbnail((W, H))
        bg = Image.new("RGBA", im.size, (128, 128, 128, 255)); bg.alpha_composite(im)
        x, y = (i % COLS) * W, (i // COLS) * (H + 28)
        sheet.paste(bg.convert("RGB"), (x, y + 28))
        g.text((x + 8, y + 8), os.path.basename(f), fill=(255, 255, 255))
    out = os.path.join(d, f"sheet-{n // (COLS * ROWS) + 1}.png")
    sheet.save(out)
    print(out)
