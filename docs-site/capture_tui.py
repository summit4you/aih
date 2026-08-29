#!/usr/bin/env python3
"""Capture the REAL AIH TUI screen by running `aih chat --mock` in a PTY,
feeding a real prompt, and reading the final terminal grid via a pyte
emulator. The grid is then rendered to a PNG (monospace, per-cell color).
This is a genuine screenshot of the program's actual output — not hand-drawn."""
import os, pty, time, select, fcntl, termios, struct, sys, json
import pyte
from PIL import Image, ImageDraw, ImageFont

COLS, ROWS = 110, 32
MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
CJK = "/usr/share/fonts/chinese/simhei.ttf"

def read_avail(fd, timeout):
    buf = b""
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                break
            if not d:
                break
            buf += d
    return buf

def run_tui():
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLUMNS"] = str(COLS)
        os.environ["LINES"] = str(ROWS)
        os.execvp("node", ["node", "cli/dist/index.js", "chat", "--mock"])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.ByteStream(screen)
    time.sleep(2.4)
    chunk = read_avail(fd, 0.6)
    if chunk:
        stream.feed(chunk)
    os.write(fd, b"add a todo: buy milk\n")
    time.sleep(2.8)
    chunk = read_avail(fd, 1.0)
    if chunk:
        stream.feed(chunk)
    os.write(fd, b"exit\n")
    time.sleep(0.9)
    chunk = read_avail(fd, 1.2)
    if chunk:
        stream.feed(chunk)
    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        pass
    # grid: list of rows; each cell has .char and .fg (e.g. '255:165:0' or 'default')
    grid = []
    for y in range(ROWS):
        row = []
        for x in range(COLS):
            c = screen.buffer[y][x]
            row.append((c.data, c.fg, c.bg, c.bold))
        grid.append(row)
    return grid

def parse_color(spec):
    if not spec or spec in ("default", "white", "black"):
        return None
    if spec.startswith("255"):
        parts = spec.split(":")
        if len(parts) == 4:
            return (int(parts[1]), int(parts[2]), int(parts[3]))
    return None

def render(grid, out):
    FS = 18
    f = ImageFont.truetype(MONO, FS)
    fcjk = ImageFont.truetype(CJK, FS)
    # measure cell size
    bb = f.getbbox("M")
    cw = (bb[2] - bb[0]) + 1
    cellh = FS + 4
    W = COLS * cw + 2
    H = ROWS * cellh + 2
    img = Image.new("RGB", (W, H), (15, 23, 42))
    d = ImageDraw.Draw(img)
    def is_cjk(ch):
        o = ord(ch)
        return 0x2E80 <= o <= 0x9FFF or 0xF900 <= o <= 0xFAFF or 0xFF00 <= o <= 0xFFEF
    fbold = ImageFont.truetype(MONO, FS)
    for y, row in enumerate(grid):
        for x, (ch, fg, bg, bold) in enumerate(row):
            if ch == " " and not bg:
                continue
            if bg:
                b = parse_color(bg)
                if b:
                    d.rectangle([x * cw, y * cellh, (x + 1) * cw, (y + 1) * cellh], fill=b)
            if ch and ch != " ":
                col = parse_color(fg) or (226, 232, 240)
                font = (fcjk if is_cjk(ch) else (fbold if bold else f))
                d.text((x * cw + 1, y * cellh + 1), ch, font=font, fill=col)
    img.save(out, "PNG", optimize=True)
    print("wrote", out, img.size)

if __name__ == "__main__":
    grid = run_tui()
    # print a plain preview
    print("=== TUI screen preview ===")
    for row in grid:
        print("".join(c[0] for c in row).rstrip())
    print("==========================")
    render(grid, "/app/agents/aih/docs-site/assets/aih-tui.png")
