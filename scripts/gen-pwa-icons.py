#!/usr/bin/env python3
"""Generate PWA icons (192 & 512) as PNGs via pure python (no deps)."""
import struct, zlib, os

def _in_tri(px, py, tri):
    (x1,y1),(x2,y2),(x3,y3) = tri
    def sign(ax,ay,bx,by,cx,cy):
        return (ax-cx)*(by-cy)-(bx-cx)*(ay-cy)
    d1 = sign(px,py,x1,y1,x2,y2)
    d2 = sign(px,py,x2,y2,x3,y3)
    d3 = sign(px,py,x3,y3,x1,y1)
    neg = (d1<0) or (d2<0) or (d3<0)
    pos = (d1>0) or (d2>0) or (d3>0)
    return not (neg and pos)

def make_icon(size, bg=(11,12,15), fg=(231,233,238)):
    W = H = size
    rows = []
    cx, cy, r = size//2, int(size*0.42), int(size*0.30)
    tail = [(int(size*0.38), int(size*0.66)), (int(size*0.52), int(size*0.66)), (int(size*0.42), int(size*0.80))]
    for y in range(H):
        row = b'\x00'
        for x in range(W):
            d2 = (x-cx)**2 + (y-cy)**2
            if d2 <= r*r or _in_tri(x, y, tail):
                row += bytes(fg) + b'\xff'
            else:
                row += bytes(bg) + b'\x00'
        rows.append(row)
    raw = b''.join(rows)
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t+d) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', W, H, 8, 6, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

if __name__ == "__main__":
    out = os.path.join(os.path.dirname(__file__), "..", "web", "public", "icons")
    os.makedirs(out, exist_ok=True)
    for size in (192, 512):
        with open(os.path.join(out, f"icon-{size}.png"), "wb") as f:
            f.write(make_icon(size))
    print("icons written to", out)
