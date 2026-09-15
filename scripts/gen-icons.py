#!/usr/bin/env python3
"""生成推妖镜图标：铜镜 + 红色电光（BotZapper）。零素材依赖，可重复生成。"""
from PIL import Image, ImageDraw
import os

GOLD = (212, 166, 74, 255)      # 铜镜金
INK = (24, 28, 40, 255)         # 镜面深色
RED = (244, 33, 46, 255)        # 电光红（X 的拉黑红）

# 经典闪电多边形（单位坐标，中心为原点）
BOLT = [
    (0.20, -0.50), (-0.20, 0.05), (0.00, 0.05),
    (-0.20, 0.50), (0.20, -0.05), (0.00, -0.05),
]


def draw_icon(size: int) -> Image.Image:
    ss = 4  # 超采样抗锯齿
    px = size * ss
    img = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    m = px * 0.03
    d.ellipse([m, m, px - m, px - m], fill=GOLD)          # 镜圈
    inset = px * 0.085
    d.ellipse([m + inset, m + inset, px - m - inset, px - m - inset], fill=INK)  # 镜面

    cx, cy = px / 2, px / 2
    s = px * 0.58
    poly = [(cx + x * s, cy + y * s) for x, y in BOLT]
    d.polygon(poly, fill=RED)                              # 电光

    return img.resize((size, size), Image.LANCZOS)


def main():
    out = os.path.join(os.path.dirname(__file__), '..', 'icons')
    os.makedirs(out, exist_ok=True)
    for size in (16, 48, 128):
        path = os.path.join(out, f'icon{size}.png')
        draw_icon(size).save(path)
        print('wrote', os.path.normpath(path))


if __name__ == '__main__':
    main()
