#!/usr/bin/env python3
"""Render an authentic AIH CLI run into a terminal-style PNG for the docs index.
Transcript is the REAL output of: aih run "add a todo: buy milk" --mock
(colored like a modern terminal; DejaVu Sans Mono + SimHei for CJK fallback)."""
from PIL import Image, ImageDraw, ImageFont
import glob

MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
MONO_B = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
CJK = "/usr/share/fonts/chinese/simhei.ttf"

def load(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()

FS = 22
f = load(MONO, FS)
fb = load(MONO_B, FS)
fcjk = load(CJK, FS)

# palette (dark terminal)
BG      = (15, 23, 42)      # #0f172a
TITLEBG = (30, 41, 59)      # #1e293b
MUTED   = (100, 116, 139)   # #64748b
FG      = (226, 232, 240)   # #e2e8f0
ACCENT  = (96, 165, 250)    # #60a5fa
GREEN   = (74, 222, 128)    # #4ade80
STRING  = (167, 243, 208)   # #a7f3d0
PROMPT  = (148, 163, 184)   # #94a3b8
DOT_RED   = (239, 68, 68)
DOT_YEL   = (250, 200, 87)
DOT_GRN   = (48, 209, 125)

# each line = list of (text, font, color)
LINES = [
    [("❯ ", fb, ACCENT), ('aih run "add a todo: buy milk" --mock', f, FG)],
    [],
    [("[aih-mcp-server] serving app ", f, MUTED), ('"todo-app"', f, STRING), (" over stdio", f, MUTED)],
    [("[session: new .aih/sessions/s-20260829-121432.jsonl]", f, MUTED)],
    [],
    [("⚙ ", f, ACCENT), ("add_todo", fb, ACCENT), (' {"text":"buy milk"}', f, MUTED)],
    [("Added via mock.", f, GREEN)],
    [],
    [("[turn turn_mteceuv6, 2 step(s), end_turn]", f, MUTED)],
]

PAD_X = 30
PAD_Y = 26
TITLE_H = 48
LINE_H = FS + 14
WIDTH = 980

# measure longest line to confirm it fits
def text_w(segs):
    w = 0
    for t, fo, _c in segs:
        bb = fo.getbbox(t)
        w += (bb[2] - bb[0])
    return w
maxw = max((text_w(l) for l in LINES), default=0)
if maxw + PAD_X * 2 > WIDTH:
    WIDTH = int(maxw) + PAD_X * 2

n_lines = len(LINES)
HEIGHT = TITLE_H + PAD_Y + n_lines * LINE_H + PAD_Y // 2

img = Image.new("RGB", (WIDTH, HEIGHT), BG)
d = ImageDraw.Draw(img)

# title bar
d.rectangle([0, 0, WIDTH, TITLE_H], fill=TITLEBG)
# traffic lights
cy = TITLE_H // 2
for i, col in enumerate([DOT_RED, DOT_YEL, DOT_GRN]):
    cx = 26 + i * 26
    d.ellipse([cx - 7, cy - 7, cx + 7, cy + 7], fill=col)
# title text (centered)
title = "aih — run"
tb = f.getbbox(title)
tw = tb[2] - tb[0]
d.text(((WIDTH - tw) / 2, (TITLE_H - FS) / 2 - 2), title, font=f, fill=(148, 163, 184))

# body lines
y = TITLE_H + PAD_Y
for line in LINES:
    if not line:
        y += LINE_H
        continue
    x = PAD_X
    for t, fo, col in line:
        # CJK fallback per-char if glyph missing in mono
        if any(ord(ch) > 0x2E00 for ch in t):
            for ch in t:
                if ord(ch) > 0x2E00:
                    d.text((x, y), ch, font=fcjk, fill=col)
                    bb = fcjk.getbbox(ch); x += bb[2] - bb[0]
                else:
                    d.text((x, y), ch, font=fo, fill=col)
                    bb = fo.getbbox(ch); x += bb[2] - bb[0]
        else:
            d.text((x, y), t, font=fo, fill=col)
            bb = fo.getbbox(t); x += bb[2] - bb[0]
    y += LINE_H

# subtle 1px inner border
d.rectangle([0, 0, WIDTH - 1, HEIGHT - 1], outline=(51, 65, 85))

out = "/app/agents/aih/docs-site/assets/aih-run.png"
import os
os.makedirs(os.path.dirname(out), exist_ok=True)
img.save(out, "PNG", optimize=True)
print("wrote", out, img.size)
