#!/usr/bin/env python3
"""
Generate Better Agent Workspace icon — Aureate Precision style.
Dark background with gold gradient circular emblem.
"""
import math
import struct
import zlib
import os

SIZE = 1024
HALF = SIZE // 2
OUTPUT_DIR = os.path.dirname(os.path.abspath(__file__))

# --- Color definitions ---
BG_COLOR = (26, 26, 46)        # #1a1a2e
BG_INNER = (22, 22, 40)        # slightly darker center

# Gold gradient stops
GOLD_BRIGHT = (255, 215, 0)     # #ffd700
GOLD_MID = (218, 165, 32)       # #daa520
GOLD_DARK = (184, 134, 11)      # #b8860b
GOLD_DEEP = (139, 101, 8)       # #8b6508
GOLD_SHADOW = (100, 72, 5)      # dark shadow

def lerp_color(c1, c2, t):
    t = max(0.0, min(1.0, t))
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))

def multi_gradient(t, stops):
    """stops = [(pos, color), ...] sorted by pos"""
    if t <= stops[0][0]:
        return stops[0][1]
    if t >= stops[-1][0]:
        return stops[-1][1]
    for i in range(len(stops) - 1):
        if stops[i][0] <= t <= stops[i+1][0]:
            local_t = (t - stops[i][0]) / (stops[i+1][0] - stops[i][0])
            return lerp_color(stops[i][1], stops[i+1][1], local_t)
    return stops[-1][1]

# Gold gradient from top-left to bottom-right (diagonal)
gold_stops = [
    (0.0, (255, 225, 80)),     # bright highlight
    (0.2, GOLD_BRIGHT),
    (0.45, GOLD_MID),
    (0.7, GOLD_DARK),
    (0.85, GOLD_DEEP),
    (1.0, GOLD_SHADOW),
]

def gold_at(x, y, cx, cy, radius):
    """Diagonal gradient based on position relative to center"""
    # Normalize to 0..1 diagonal
    t = ((x - cx + radius) + (y - cy + radius)) / (4 * radius)
    return multi_gradient(t, gold_stops)

def dist(x, y, cx, cy):
    return math.sqrt((x - cx)**2 + (y - cy)**2)

def smooth_step(edge0, edge1, x):
    t = max(0.0, min(1.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)

# --- Drawing helpers ---
def draw_arc_stroke(pixels, cx, cy, radius, stroke_w, start_deg, end_deg, gradient_fn, aa=2.0):
    """Draw an arc with anti-aliased stroke"""
    r_outer = radius + stroke_w / 2
    r_inner = radius - stroke_w / 2

    # Bounding box
    x0 = max(0, int(cx - r_outer - 2))
    x1 = min(SIZE - 1, int(cx + r_outer + 2))
    y0 = max(0, int(cy - r_outer - 2))
    y1 = min(SIZE - 1, int(cy + r_outer + 2))

    start_rad = math.radians(start_deg)
    end_rad = math.radians(end_deg)

    for py in range(y0, y1 + 1):
        for px in range(x0, x1 + 1):
            d = dist(px, py, cx, cy)

            # Distance from stroke center
            stroke_dist = abs(d - radius)
            if stroke_dist > stroke_w / 2 + aa:
                continue

            # Angle check
            angle = math.atan2(py - cy, px - cx)
            if angle < 0:
                angle += 2 * math.pi

            s = start_rad
            e = end_rad
            if s < 0: s += 2 * math.pi
            if e < 0: e += 2 * math.pi

            in_arc = False
            if s <= e:
                in_arc = s <= angle <= e
            else:
                in_arc = angle >= s or angle <= e

            if not in_arc:
                # Check near endpoints for anti-aliasing
                continue

            # Alpha from stroke edge
            alpha = 1.0 - smooth_step(stroke_w / 2 - aa, stroke_w / 2 + aa, stroke_dist)
            if alpha <= 0:
                continue

            color = gradient_fn(px, py)
            bg = pixels[py][px]
            blended = tuple(int(bg[i] * (1 - alpha) + color[i] * alpha) for i in range(3))
            pixels[py][px] = blended

def draw_circle_stroke(pixels, cx, cy, radius, stroke_w, gradient_fn, aa=2.0):
    draw_arc_stroke(pixels, cx, cy, radius, stroke_w, 0, 360, gradient_fn, aa)

def draw_line_stroke(pixels, x1, y1, x2, y2, stroke_w, gradient_fn, aa=1.5):
    """Draw anti-aliased line with given stroke width"""
    dx = x2 - x1
    dy = y2 - y1
    length = math.sqrt(dx*dx + dy*dy)
    if length == 0:
        return
    nx = -dy / length  # normal
    ny = dx / length

    min_x = max(0, int(min(x1, x2) - stroke_w - 2))
    max_x = min(SIZE - 1, int(max(x1, x2) + stroke_w + 2))
    min_y = max(0, int(min(y1, y2) - stroke_w - 2))
    max_y = min(SIZE - 1, int(max(y1, y2) + stroke_w + 2))

    for py in range(min_y, max_y + 1):
        for px in range(min_x, max_x + 1):
            # Project point onto line
            t = ((px - x1) * dx + (py - y1) * dy) / (length * length)

            # Distance from line segment
            if t < 0:
                d = dist(px, py, x1, y1)
            elif t > 1:
                d = dist(px, py, x2, y2)
            else:
                closest_x = x1 + t * dx
                closest_y = y1 + t * dy
                d = dist(px, py, closest_x, closest_y)

            if d > stroke_w / 2 + aa:
                continue

            alpha = 1.0 - smooth_step(stroke_w / 2 - aa, stroke_w / 2 + aa, d)
            if alpha <= 0:
                continue

            color = gradient_fn(px, py)
            bg = pixels[py][px]
            blended = tuple(int(bg[i] * (1 - alpha) + color[i] * alpha) for i in range(3))
            pixels[py][px] = blended

def draw_rounded_rect_filled(pixels, x, y, w, h, r, color):
    """Fill a rounded rectangle"""
    for py in range(max(0, int(y)), min(SIZE, int(y + h))):
        for px in range(max(0, int(x)), min(SIZE, int(x + w))):
            rx = px - x
            ry = py - y
            inside = True

            # Check corners
            if rx < r and ry < r:
                inside = dist(rx, ry, r, r) <= r
            elif rx > w - r and ry < r:
                inside = dist(rx, ry, w - r, r) <= r
            elif rx < r and ry > h - r:
                inside = dist(rx, ry, r, h - r) <= r
            elif rx > w - r and ry > h - r:
                inside = dist(rx, ry, w - r, h - r) <= r

            if inside:
                pixels[py][px] = color

def draw_rounded_rect_aa(pixels, x, y, w, h, r, color, aa=2.0):
    """Fill a rounded rectangle with anti-aliasing on edges"""
    for py in range(max(0, int(y - 2)), min(SIZE, int(y + h + 2))):
        for px in range(max(0, int(x - 2)), min(SIZE, int(x + w + 2))):
            rx = px - x
            ry = py - y

            # Signed distance to rounded rect
            qx = abs(rx - w/2) - w/2 + r
            qy = abs(ry - h/2) - h/2 + r

            if qx <= 0 and qy <= 0:
                sd = max(qx, qy) - r
            elif qx <= 0:
                sd = qy - r
            elif qy <= 0:
                sd = qx - r
            else:
                sd = math.sqrt(qx*qx + qy*qy) - r

            if sd > aa:
                continue

            alpha = 1.0 - smooth_step(-aa, aa, sd)
            if alpha <= 0:
                continue

            bg = pixels[py][px]
            blended = tuple(int(bg[i] * (1 - alpha) + color[i] * alpha) for i in range(3))
            pixels[py][px] = blended

# --- PNG writer ---
def write_png(filename, pixels, width, height):
    def make_chunk(chunk_type, data):
        chunk = chunk_type + data
        crc = struct.pack('>I', zlib.crc32(chunk) & 0xffffffff)
        return struct.pack('>I', len(data)) + chunk + crc

    raw = b''
    for y in range(height):
        raw += b'\x00'  # filter none
        for x in range(width):
            r, g, b = pixels[y][x]
            raw += struct.pack('BBB', r, g, b)

    compressed = zlib.compress(raw, 9)

    png = b'\x89PNG\r\n\x1a\n'
    png += make_chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
    png += make_chunk(b'IDAT', compressed)
    png += make_chunk(b'IEND', b'')

    with open(filename, 'wb') as f:
        f.write(png)

# ============================================================
# MAIN ICON GENERATION
# ============================================================

print("Creating 1024x1024 icon...")
pixels = [[BG_COLOR for _ in range(SIZE)] for _ in range(SIZE)]

# 1. Background: rounded square (macOS squircle approximation)
corner_r = 220
draw_rounded_rect_aa(pixels, 0, 0, SIZE, SIZE, corner_r, BG_COLOR)

# Subtle radial gradient on background for depth
print("  Background gradient...")
for y in range(SIZE):
    for x in range(SIZE):
        d = dist(x, y, HALF, HALF) / (HALF * 1.2)
        d = min(1.0, d)
        # Subtle vignette
        factor = 1.0 - d * 0.15
        bg = pixels[y][x]
        pixels[y][x] = tuple(max(0, min(255, int(c * factor))) for c in bg)

# 2. Main emblem: circular gold ring
print("  Drawing outer ring...")
ring_cx, ring_cy = HALF, HALF
ring_r = 310
ring_stroke = 42

def gold_gradient(px, py):
    return gold_at(px, py, ring_cx, ring_cy, ring_r)

# Outer ring - but with a gap for the "C" shape opening (right side, ~30 degrees opening)
# Draw the C shape: arc from about 35 degrees to 325 degrees
draw_arc_stroke(pixels, ring_cx, ring_cy, ring_r, ring_stroke, 40, 320, gold_gradient, aa=2.5)

# 3. Inner arc element (smaller C-curve inside, offset slightly)
print("  Drawing inner arcs...")
inner_r = 210
inner_stroke = 36

# Inner arc - rotated differently for visual interest
draw_arc_stroke(pixels, ring_cx, ring_cy, inner_r, inner_stroke, 160, 380, gold_gradient, aa=2.5)

# 4. Two diagonal stripes (like the reference image)
print("  Drawing diagonal stripes...")
stripe_w = 38

# Stripe 1: upper diagonal
s1_x1 = ring_cx + 40
s1_y1 = ring_cy - 220
s1_x2 = ring_cx + 260
s1_y2 = ring_cy + 60

draw_line_stroke(pixels, s1_x1, s1_y1, s1_x2, s1_y2, stripe_w, gold_gradient, aa=2.0)

# Stripe 2: lower diagonal (parallel, shifted down)
s2_x1 = ring_cx + 10
s2_y1 = ring_cy - 60
s2_x2 = ring_cx + 230
s2_y2 = ring_cy + 220

draw_line_stroke(pixels, s2_x1, s2_y1, s2_x2, s2_y2, stripe_w, gold_gradient, aa=2.0)

# 5. Cut the background through the stripes to create the "negative space" effect
# The stripes should have gaps where they cross the arcs (like the reference)
# We'll achieve this by redrawing the background in the intersection areas

print("  Carving negative space gaps...")

# Redraw background where stripes intersect with arcs
# This creates the illusion of stripes going behind/through the arcs
for py in range(SIZE):
    for px in range(SIZE):
        d_outer = dist(px, py, ring_cx, ring_cy)
        d_inner = dist(px, py, ring_cx, ring_cy)

        # Check if point is on a stripe
        on_stripe = False
        for (lx1, ly1, lx2, ly2) in [(s1_x1, s1_y1, s1_x2, s1_y2), (s2_x1, s2_y1, s2_x2, s2_y2)]:
            dx = lx2 - lx1
            dy = ly2 - ly1
            length = math.sqrt(dx*dx + dy*dy)
            t = ((px - lx1) * dx + (py - ly1) * dy) / (length * length)
            if 0 <= t <= 1:
                closest_x = lx1 + t * dx
                closest_y = ly1 + t * dy
                d = dist(px, py, closest_x, closest_y)
                if d < stripe_w / 2 + 3:
                    on_stripe = True
                    break

        if not on_stripe:
            continue

        # Check intersection with outer ring
        outer_d = abs(d_outer - ring_r)
        if outer_d < ring_stroke / 2 + 5:
            # In the ring zone - create gap by darkening
            gap_alpha = 1.0 - smooth_step(ring_stroke/2 - 4, ring_stroke/2 + 2, outer_d)
            if gap_alpha > 0.1:
                bg = BG_COLOR
                current = pixels[py][px]
                pixels[py][px] = tuple(int(current[i] * (1 - gap_alpha * 0.85) + bg[i] * gap_alpha * 0.85) for i in range(3))

        # Check intersection with inner arc
        inner_d = abs(d_inner - inner_r)
        if inner_d < inner_stroke / 2 + 5:
            angle = math.atan2(py - ring_cy, px - ring_cx)
            if angle < 0: angle += 2 * math.pi
            start_rad = math.radians(160)
            end_rad = math.radians(380) % (2 * math.pi)
            in_inner_arc = angle >= start_rad or angle <= end_rad
            if in_inner_arc:
                gap_alpha = 1.0 - smooth_step(inner_stroke/2 - 4, inner_stroke/2 + 2, inner_d)
                if gap_alpha > 0.1:
                    bg = BG_COLOR
                    current = pixels[py][px]
                    pixels[py][px] = tuple(int(current[i] * (1 - gap_alpha * 0.7) + bg[i] * gap_alpha * 0.7) for i in range(3))

# 6. Subtle glow behind the gold elements
print("  Adding glow effect...")
# We'll add a subtle gold glow by going through and adding bloom
glow_layer = [[0.0 for _ in range(SIZE)] for _ in range(SIZE)]
for y in range(SIZE):
    for x in range(SIZE):
        r, g, b = pixels[y][x]
        # Check if pixel is "gold" (warm, bright)
        if r > 120 and g > 80 and r > b * 2:
            brightness = (r + g) / (510.0)
            glow_layer[y][x] = brightness

# Simple box blur for glow
print("  Blurring glow (this takes a moment)...")
GLOW_RADIUS = 12
GLOW_STEP = 2  # Sample every Nth pixel for speed
glow_blurred = [[0.0 for _ in range(SIZE)] for _ in range(SIZE)]

for y in range(0, SIZE, GLOW_STEP):
    for x in range(0, SIZE, GLOW_STEP):
        total = 0.0
        count = 0
        for dy in range(-GLOW_RADIUS, GLOW_RADIUS + 1, 2):
            for dx in range(-GLOW_RADIUS, GLOW_RADIUS + 1, 2):
                ny, nx = y + dy, x + dx
                if 0 <= ny < SIZE and 0 <= nx < SIZE:
                    total += glow_layer[ny][nx]
                    count += 1
        val = total / count if count > 0 else 0
        # Fill the step block
        for sy in range(GLOW_STEP):
            for sx in range(GLOW_STEP):
                if y + sy < SIZE and x + sx < SIZE:
                    glow_blurred[y + sy][x + sx] = val

# Apply glow
GLOW_INTENSITY = 0.3
GLOW_COLOR = (255, 200, 50)
for y in range(SIZE):
    for x in range(SIZE):
        g = glow_blurred[y][x] * GLOW_INTENSITY
        if g > 0.01:
            current = pixels[y][x]
            pixels[y][x] = tuple(min(255, int(current[i] + GLOW_COLOR[i] * g * 0.15)) for i in range(3))

# 7. Apply macOS squircle mask (darken corners outside the rounded rect)
print("  Applying squircle mask...")
for y in range(SIZE):
    for x in range(SIZE):
        rx = abs(x - HALF)
        ry = abs(y - HALF)

        # Squircle formula: (x/a)^4 + (y/b)^4 = 1
        a = HALF - 8
        b = HALF - 8
        squircle_val = (rx / a) ** 4 + (ry / b) ** 4 if a > 0 and b > 0 else 2

        if squircle_val > 1.0:
            # Outside squircle - fade to transparent (black for PNG without alpha)
            fade = 1.0 - smooth_step(1.0, 1.08, squircle_val)
            if fade < 1.0:
                current = pixels[y][x]
                # Fade to a dark edge
                pixels[y][x] = tuple(int(c * fade) for c in current)

# 8. Subtle noise texture for premium feel
print("  Adding texture...")
import random
random.seed(42)
for y in range(SIZE):
    for x in range(SIZE):
        noise = random.gauss(0, 2.5)
        current = pixels[y][x]
        pixels[y][x] = tuple(max(0, min(255, int(c + noise))) for c in current)

# Write output
output_path = os.path.join(OUTPUT_DIR, 'icon-new.png')
print(f"  Writing {output_path}...")
write_png(output_path, pixels, SIZE, SIZE)
print("Done!")

# Also generate smaller sizes
for target_size in [512, 256, 128, 64, 48, 32, 16]:
    print(f"  Generating {target_size}x{target_size}...")
    small = [[BG_COLOR for _ in range(target_size)] for _ in range(target_size)]
    scale = SIZE / target_size
    for y in range(target_size):
        for x in range(target_size):
            # Simple area sampling
            src_x = int(x * scale)
            src_y = int(y * scale)
            # Average a small block
            r_sum, g_sum, b_sum, count = 0, 0, 0, 0
            step = max(1, int(scale / 2))
            for sy in range(0, int(scale), step):
                for sx in range(0, int(scale), step):
                    sx2, sy2 = min(SIZE-1, src_x + sx), min(SIZE-1, src_y + sy)
                    c = pixels[sy2][sx2]
                    r_sum += c[0]; g_sum += c[1]; b_sum += c[2]
                    count += 1
            if count > 0:
                small[y][x] = (r_sum // count, g_sum // count, b_sum // count)

    out = os.path.join(OUTPUT_DIR, f'icon-new-{target_size}.png')
    write_png(out, small, target_size, target_size)

print("All sizes generated!")
