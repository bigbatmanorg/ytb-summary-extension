"""Draw the toolbar icons (rounded red tile, play triangle, summary lines)."""
from PIL import Image, ImageDraw

def icon(size):
    s = 8  # supersample
    W = size * s
    im = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, W - 1, W - 1], radius=W * 0.22, fill=(214, 40, 40, 255))
    # play triangle, left half
    d.polygon([(W * 0.16, W * 0.26), (W * 0.16, W * 0.74), (W * 0.50, W * 0.50)], fill='white')
    # three "summary" lines, right half
    for i, y in enumerate((0.30, 0.50, 0.70)):
        x2 = W * (0.84 if i < 2 else 0.72)
        d.rounded_rectangle([W * 0.56, W * (y - 0.055), x2, W * (y + 0.055)], radius=W * 0.05, fill='white')
    return im.resize((size, size), Image.LANCZOS)

for n in (16, 32, 48, 128):
    icon(n).save(f'icons/icon{n}.png')
