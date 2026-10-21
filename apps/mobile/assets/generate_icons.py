"""Generate Android launcher artwork from the app's existing color palette.

The generated PNGs are committed so a build does not require Pillow.
Run with: python assets/generate_icons.py
"""

from pathlib import Path
from PIL import Image, ImageDraw


SIZE = 1024
SCALE = 4
GREEN = "#375B4A"
CREAM = "#F7F5F0"
PAGE_SHADE = "#E8F0EA"
GOLD = "#E5BC75"
OUTPUT = Path(__file__).parent


def polygon(draw, points, color):
    draw.polygon([(x * SCALE, y * SCALE) for x, y in points], fill=color)


def line(draw, points, color, width):
    draw.line([(x * SCALE, y * SCALE) for x, y in points], fill=color, width=width * SCALE, joint="curve")


def artwork(monochrome=False):
    image = Image.new("RGBA", (SIZE * SCALE, SIZE * SCALE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    page = "#FFFFFF" if monochrome else CREAM
    shadow = "#FFFFFF" if monochrome else PAGE_SHADE

    # The entire mark stays within the central adaptive-icon safe area.
    draw.ellipse((628 * SCALE, 258 * SCALE, 700 * SCALE, 330 * SCALE), fill=page if monochrome else GOLD)
    polygon(draw, [(256, 355), (408, 335), (512, 383), (616, 335), (768, 355),
                   (768, 711), (620, 697), (512, 742), (404, 697), (256, 711)], shadow)
    polygon(draw, [(270, 347), (406, 331), (512, 383), (512, 716), (410, 668), (270, 682)], page)
    polygon(draw, [(754, 347), (618, 331), (512, 383), (512, 716), (614, 668), (754, 682)], page)

    if not monochrome:
        line(draw, [(512, 383), (512, 716)], GREEN, 10)
        for y, inset in [(430, 0), (476, 6), (522, 12)]:
            line(draw, [(310 + inset, y), (429, y + 3)], "#A6BEAE", 9)
            line(draw, [(595, y + 3), (714 - inset, y)], "#A6BEAE", 9)

    return image.resize((SIZE, SIZE), Image.Resampling.LANCZOS)


def main():
    foreground = artwork()
    foreground.save(OUTPUT / "adaptive-foreground.png")
    artwork(monochrome=True).save(OUTPUT / "adaptive-monochrome.png")

    icon = Image.new("RGBA", (SIZE, SIZE), GREEN)
    icon.alpha_composite(foreground)
    icon.convert("RGB").save(OUTPUT / "icon.png")


if __name__ == "__main__":
    main()
