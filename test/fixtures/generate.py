#!/usr/bin/env python3
"""Generate deterministic screenshot-like PNG fixtures (requires Pillow >= 10.1).

Usage: python3 test/fixtures/generate.py
"""
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent
WORDS = (
    "const import export function return await async interface type extends "
    "messages image budget request context trim compress resize factory magpie "
    "error warning info debug true false null undefined string number"
).split()


def gradient(width, height, top, bottom):
    column = Image.new("RGB", (1, height))
    for y in range(height):
        t = y / max(1, height - 1)
        column.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    return column.resize((width, height))


def line_of_code(rng):
    indent = "  " * rng.randint(0, 4)
    return indent + " ".join(rng.choice(WORDS) for _ in range(rng.randint(2, 9)))


def screenshot(width, height, seed):
    rng = random.Random(seed)
    scale = width / 1440
    font = ImageFont.load_default(size=round(13 * scale))
    small = ImageFont.load_default(size=round(11 * scale))
    title = ImageFont.load_default(size=round(20 * scale))
    image = gradient(width, height, (32, 36, 52), (18, 20, 28))
    draw = ImageDraw.Draw(image)
    s = lambda v: round(v * scale)

    # Window title bar and traffic lights.
    draw.rectangle((0, 0, width, s(28)), fill=(44, 46, 58))
    for i, color in enumerate(((255, 95, 86), (255, 189, 46), (39, 201, 63))):
        draw.ellipse((s(12 + i * 20), s(8), s(24 + i * 20), s(20)), fill=color)
    draw.text((width // 2 - s(80), s(7)), "pi - factory-trim", font=small, fill=(200, 200, 210))

    # Sidebar file tree.
    sidebar = s(260)
    draw.rectangle((0, s(28), sidebar, height), fill=(28, 30, 40))
    for i in range(int((height - s(40)) / s(22))):
        y = s(40) + i * s(22)
        if i == 6:
            draw.rectangle((0, y - s(3), sidebar, y + s(17)), fill=(55, 70, 110))
        draw.text((s(16 + 12 * rng.randint(0, 3)), y), f"{rng.choice(WORDS)}_{rng.randint(1, 99)}.ts", font=font, fill=(170, 175, 190))

    # Editor with syntax-coloured code and line numbers.
    editor_right = width - s(360)
    palette = ((198, 120, 221), (97, 175, 239), (152, 195, 121), (229, 192, 123), (220, 223, 228))
    for i in range(int((height - s(260)) / s(19))):
        y = s(44) + i * s(19)
        draw.text((sidebar + s(12), y), f"{i + 1:>4}", font=font, fill=(90, 95, 110))
        x = sidebar + s(64)
        for word in line_of_code(rng).split(" "):
            if not word:
                x += s(14)
                continue
            draw.text((x, y), word, font=font, fill=rng.choice(palette))
            x += draw.textlength(word + " ", font=font)
            if x > editor_right - s(20):
                break

    # Right panel: cards with gradients, a chart and a photo-like noisy thumbnail.
    panel = (editor_right, s(28), width, height)
    draw.rectangle(panel, fill=(24, 26, 36))
    for i in range(3):
        top = s(48 + i * 170)
        card = gradient(s(320), s(150), (60 + 30 * i, 80, 140), (30, 40 + 20 * i, 70))
        image.paste(card, (editor_right + s(20), top))
        draw.text((editor_right + s(36), top + s(14)), f"Card {i + 1}: {rng.choice(WORDS)}", font=title, fill=(240, 240, 250))
        for j in range(4):
            draw.text((editor_right + s(36), top + s(52 + j * 22)), line_of_code(rng)[:34], font=small, fill=(210, 215, 230))
    chart_top = s(560)
    points = [(editor_right + s(30 + k * 10), chart_top + s(140) - s(rng.randint(10, 130))) for k in range(30)]
    draw.rectangle((editor_right + s(20), chart_top, width - s(20), chart_top + s(160)), outline=(80, 85, 100), width=max(1, s(1)))
    draw.line(points, fill=(97, 175, 239), width=max(1, s(2)))
    thumb = Image.effect_noise((s(320), s(180)), 48).convert("RGB")
    thumb = Image.blend(thumb, gradient(s(320), s(180), (180, 120, 60), (40, 90, 160)), 0.6)
    image.paste(thumb, (editor_right + s(20), chart_top + s(180)))

    # Bottom terminal pane.
    term_top = height - s(210)
    draw.rectangle((sidebar, term_top, editor_right, height), fill=(14, 15, 20))
    for i in range(9):
        colour = rng.choice(((152, 195, 121), (224, 108, 117), (171, 178, 191)))
        draw.text((sidebar + s(12), term_top + s(10 + i * 21)), "$ " + line_of_code(rng), font=font, fill=colour)
    return image


def main():
    for width, height, name in ((1920, 1080, "screenshot-1920x1080.png"), (2880, 1800, "screenshot-2880x1800.png")):
        path = OUT / name
        screenshot(width, height, seed=width).save(path, optimize=True)
        print(f"{path.name}: {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
