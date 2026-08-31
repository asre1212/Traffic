#!/usr/bin/env python3
"""Generate the PWA icon set (no image libraries needed).

Draws a road receding to the horizon with a dashed centre line and an amber
"incident" dot, on the app's navy gradient. Run: npm run icons
"""
import struct, zlib, os, math

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "icons")
BG_TOP, BG_BOTTOM = (11, 16, 32), (26, 38, 82)
ROAD = (38, 44, 62)
LINE = (240, 244, 255)
AMBER = (255, 176, 32)


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def in_triangle(px, py, a, b, c):
    def sign(p, q, r):
        return (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1])
    d1, d2, d3 = sign((px, py), a, b), sign((px, py), b, c), sign((px, py), c, a)
    neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (neg and pos)


def in_quad(px, py, quad):
    a, b, c, d = quad
    return in_triangle(px, py, a, b, c) or in_triangle(px, py, a, c, d)


def render(size, padding):
    """padding: fraction of the canvas kept clear (maskable icons need more)."""
    s = size
    inner = s * (1 - 2 * padding)
    x0, y0 = s * padding, s * padding
    # Road quad: narrow at the horizon, wide at the bottom.
    horizon_y = y0 + inner * 0.30
    bottom_y = y0 + inner * 0.98
    cx = s / 2
    quad = [(cx - inner * 0.055, horizon_y), (cx + inner * 0.055, horizon_y),
            (cx + inner * 0.42, bottom_y), (cx - inner * 0.42, bottom_y)]
    dot = (cx + inner * 0.27, y0 + inner * 0.20, inner * 0.085)

    rows = []
    for y in range(s):
        row = bytearray()
        for x in range(s):
            px, py = x + 0.5, y + 0.5
            colour = lerp(BG_TOP, BG_BOTTOM, py / s)
            if in_quad(px, py, quad):
                colour = ROAD
                # Dashed centre line: dashes get wider and longer toward the viewer.
                t = (py - horizon_y) / (bottom_y - horizon_y)
                if 0 <= t <= 1:
                    half = inner * (0.006 + 0.022 * t)
                    if abs(px - cx) < half:
                        phase = (t ** 0.4) * 6.5
                        if phase % 1.0 < 0.55:
                            colour = LINE
            if (px - dot[0]) ** 2 + (py - dot[1]) ** 2 < dot[2] ** 2:
                colour = AMBER
            row += bytes(colour)
        rows.append(bytes(row))
    return rows


def write_png(path, rows, size):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for name, size, pad in [("icon-180.png", 180, 0.10), ("icon-192.png", 192, 0.10),
                            ("icon-512.png", 512, 0.10), ("icon-maskable-512.png", 512, 0.20)]:
        write_png(os.path.join(OUT, name), render(size, pad), size)
        print("wrote", name)
