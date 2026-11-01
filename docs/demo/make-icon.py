# Draws Grabbit's app icon (1024 px): a rounded square with a gradient, white selection corners and a rabbit-ear
# notch. `bun tauri icon docs/demo/icon.png` turns it into every size each OS needs.
from PIL import Image, ImageDraw, ImageFilter

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# Gradient tile.
grad = Image.new("RGBA", (S, S))
top, bottom = (255, 122, 69), (232, 57, 109)
for y in range(S):
    t = y / (S - 1)
    c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
    ImageDraw.Draw(grad).line([(0, y), (S, y)], fill=c)
mask = Image.new("L", (S, S), 0)
pad = 72
ImageDraw.Draw(mask).rounded_rectangle([pad, pad, S - pad, S - pad], radius=210, fill=255)
shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle([pad, pad + 18, S - pad, S - pad + 18], radius=210, fill=(0, 0, 0, 90))
img = Image.alpha_composite(img, shadow.filter(ImageFilter.GaussianBlur(24)))
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)
w = 64
a, b = 300, 724  # selection box
L = 150
for (x, y, dx, dy) in [(a, a, 1, 1), (b, a, -1, 1), (a, b, 1, -1), (b, b, -1, -1)]:
    d.line([(x + dx * L, y), (x, y), (x, y + dy * L)], fill="white", width=w, joint="curve")
# Two ears poking out of the selection.
for cx in (452, 572):
    d.rounded_rectangle([cx - 42, 330, cx + 42, 560], radius=42, fill="white")
d.ellipse([392, 470, 632, 690], fill="white")

img.save(__file__.replace("make-icon.py", "icon.png"))
