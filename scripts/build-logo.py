"""Draw the Gofer mark: the dot-matrix "g" from the app's display face, lit on a dark tile.

    uv run --project agent --group dev python scripts/build-logo.py

Writes assets/logo.png and the app icons under web/public/icons, and the favicon as SVG.
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
G = ".#### #...# #...# #...# .#### ....# .###.".split()
INK, UNLIT, LIT, HOT = "#14110f", "#2a2622", "#ece8df", "#f29a6b"
# The descender's last dot is the one that is lit in colour: the errand, on its way back.
HOT_CELL = (6, 1)


def cells():
    for row, line in enumerate(G):
        for col, char in enumerate(line):
            yield row, col, char == "#"


def draw(size, radius, inset):
    """One tile. `inset` is the share of the tile left as margin around the glyph."""
    scale = 4
    side = size * scale
    image = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    pen = ImageDraw.Draw(image)
    pen.rounded_rectangle((0, 0, side - 1, side - 1), radius * scale, fill=INK)
    pitch = side * (1 - 2 * inset) / len(G)
    left = (side - pitch * 5) / 2
    top = (side - pitch * len(G)) / 2
    dot = pitch * 0.4
    for row, col, lit in cells():
        x = left + (col + 0.5) * pitch
        y = top + (row + 0.5) * pitch
        colour = HOT if (row, col) == HOT_CELL else LIT if lit else UNLIT
        pen.ellipse((x - dot, y - dot, x + dot, y + dot), fill=colour)
    return image.resize((size, size), Image.LANCZOS)


def svg():
    dots = "".join(
        f'<circle cx="{col + 1.5}" cy="{row + 1}" r="0.4" fill="{HOT if (row, col) == HOT_CELL else LIT if lit else UNLIT}"/>'
        for row, col, lit in cells()
    )
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-0.5 0 9 9"><rect x="-0.5" width="9" height="9" rx="2" fill="{INK}"/><g transform="translate(1 0.5)">{dots}</g></svg>\n'


def main():
    (ROOT / "assets").mkdir(exist_ok=True)
    draw(512, 112, 0.2).save(ROOT / "assets/logo.png")
    icons = ROOT / "web/public/icons"
    draw(192, 42, 0.2).save(icons / "hub-192.png")
    draw(512, 112, 0.2).save(icons / "hub-512.png")
    # Maskable and Apple icons are cropped by the platform: square, with a wider margin.
    draw(512, 0, 0.27).save(icons / "hub-maskable-512.png")
    draw(180, 0, 0.22).convert("RGB").save(icons / "apple-touch-icon.png")
    (ROOT / "web/src/assets/mark.svg").write_text(svg())


if __name__ == "__main__":
    main()
