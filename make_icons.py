#!/usr/bin/env python3
"""Generate DrivePass PNG icons (no external deps)."""
import struct, zlib, math, os

BG = (79, 70, 229, 255)      # indigo
FG = (255, 255, 255, 255)    # white key

def rounded(x, y, w, h, r, px, py):
    """Is (px,py) inside a rounded rect?"""
    if px < x or px > x + w or py < y or py > y + h:
        return False
    for cx, cy in ((x+r, y+r), (x+w-r, y+r), (x+r, y+h-r), (x+w-r, y+h-r)):
        if (px < x+r or px > x+w-r) and (py < y+r or py > y+h-r):
            if (px-cx)**2 + (py-cy)**2 > r*r:
                return False
    return True

def make(size):
    px = [[(0, 0, 0, 0) for _ in range(size)] for _ in range(size)]
    r = size * 0.22
    for y in range(size):
        for x in range(size):
            if rounded(0, 0, size-1, size-1, r, x, y):
                px[y][x] = BG
    # key bow (ring) center
    cx, cy = size*0.40, size*0.38
    outer = size*0.18
    inner = size*0.09
    for y in range(size):
        for x in range(size):
            d = math.hypot(x-cx, y-cy)
            if inner <= d <= outer:
                px[y][x] = FG
    # key stem + teeth
    sw = max(1, size*0.06)
    sx0, sy0 = cx + size*0.10, cy + size*0.06
    for y in range(size):
        for x in range(size):
            # diagonal stem
            along = (x - sx0) + (y - sy0)
            perp = (x - sx0) - (y - sy0)
            if 0 <= along <= size*0.5 and -sw <= perp <= sw:
                px[y][x] = FG
    return px

def write_png(path, px):
    size = len(px)
    raw = bytearray()
    for row in px:
        raw.append(0)
        for (r, g, b, a) in row:
            raw += bytes((r, g, b, a))
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)

here = os.path.join(os.path.dirname(__file__), "icons")
os.makedirs(here, exist_ok=True)
for s in (16, 48, 128):
    write_png(os.path.join(here, f"icon{s}.png"), make(s))
    print("wrote icon%d.png" % s)
