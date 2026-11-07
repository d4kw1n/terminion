"""Generate the Terminion app icon (1024x1024 master PNG)."""
from PIL import Image, ImageDraw, ImageFilter, ImageFont

S = 1024
SS = 4  # supersampling
W = S * SS


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def radial_glow(size, center, radius, color):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    steps = 60
    for i in range(steps, 0, -1):
        t = i / steps
        r = radius * t
        alpha = int(color[3] * (1 - t) ** 2.1)
        d.ellipse(
            [center[0] - r, center[1] - r, center[0] + r, center[1] + r],
            fill=color[:3] + (alpha,),
        )
    return img.filter(ImageFilter.GaussianBlur(size // 90))


canvas = Image.new("RGBA", (W, W), (0, 0, 0, 0))
draw = ImageDraw.Draw(canvas)

# --- rounded-square background with vertical gradient -------------------
margin = int(W * 0.055)
radius = int(W * 0.235)
top = (94, 66, 232)      # indigo
bottom = (48, 32, 128)   # deep violet
grad = Image.new("RGBA", (W, W), (0, 0, 0, 0))
gd = ImageDraw.Draw(grad)
for y in range(margin, W - margin):
    t = (y - margin) / max(1, (W - 2 * margin))
    gd.line([(margin, y), (W - margin, y)], fill=lerp(top, bottom, t) + (255,))

mask = Image.new("L", (W, W), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([margin, margin, W - margin, W - margin], radius=radius, fill=255)
canvas.paste(grad, (0, 0), mask)

# --- glow accents --------------------------------------------------------
glow = radial_glow(W, (int(W * 0.22), int(W * 0.18)), int(W * 0.55), (150, 125, 255, 150))
glow2 = radial_glow(W, (int(W * 0.85), int(W * 0.9)), int(W * 0.45), (34, 211, 166, 90))
canvas = Image.alpha_composite(canvas, Image.composite(glow, Image.new("RGBA", (W, W)), mask))
canvas = Image.alpha_composite(canvas, Image.composite(glow2, Image.new("RGBA", (W, W)), mask))

# thin inner border for a crisp edge
draw = ImageDraw.Draw(canvas)
draw.rounded_rectangle(
    [margin + 3 * SS, margin + 3 * SS, W - margin - 3 * SS, W - margin - 3 * SS],
    radius=radius,
    outline=(255, 255, 255, 40),
    width=3 * SS,
)

# --- terminal prompt glyph (hand drawn for crisp balance) ---------------
def pt(x, y):
    return (W * x, W * y)

w = int(W * 0.082)
glyph = Image.new("RGBA", (W, W), (0, 0, 0, 0))
gd = ImageDraw.Draw(glyph)
chevron = [pt(0.305, 0.335), pt(0.475, 0.505), pt(0.305, 0.675)]
gd.line(chevron, fill=(255, 255, 255, 255), width=w, joint="curve")
for x, y in chevron:
    gd.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=(255, 255, 255, 255))
underscore = [pt(0.565, 0.675), pt(0.735, 0.675)]
gd.line(underscore, fill=(255, 255, 255, 255), width=w)
for x, y in underscore:
    gd.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=(255, 255, 255, 255))

shadow = glyph.filter(ImageFilter.GaussianBlur(W // 80))
shadow_alpha = shadow.split()[3].point(lambda a: int(a * 0.55))
shadow.putalpha(shadow_alpha)
shadow = shadow.transform(
    shadow.size, Image.AFFINE, (1, 0, -W * 0.004, 0, 1, -W * 0.012)
)
canvas = Image.alpha_composite(canvas, shadow)
canvas = Image.alpha_composite(canvas, glyph)

draw = ImageDraw.Draw(canvas)
dot_r = W * 0.046
cx, cy = W * 0.735, 0.405 * W
draw.ellipse(
    [cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r],
    fill=(34, 211, 166, 255),
    outline=(255, 255, 255, 90),
    width=int(W * 0.005),
)

canvas = canvas.resize((S, S), Image.LANCZOS)
canvas.save("tools/terminion-icon.png")
print("wrote tools/terminion-icon.png")
