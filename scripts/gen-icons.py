#!/usr/bin/env python3
"""生成推妖镜图标。

优先使用 icons/image.jpg 中的圆形镜妖徽标（自动定位裁切、加圆角），
没有源图时回退到程序绘制的铜镜+电光占位图标。
"""
from PIL import Image, ImageDraw, ImageFilter
import os

GOLD = (212, 166, 74, 255)      # 铜镜金
INK = (24, 28, 40, 255)         # 镜面深色
RED = (244, 33, 46, 255)        # 电光红（X 的拉黑红）
HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.normpath(os.path.join(HERE, '..', 'icons'))
SOURCE = os.path.join(ICONS, 'image.jpg')


# 经典闪电多边形（单位坐标，中心为原点），占位图标用
BOLT = [
    (0.20, -0.50), (-0.20, 0.05), (0.00, 0.05),
    (-0.20, 0.50), (0.20, -0.05), (0.00, -0.05),
]


def draw_placeholder(size: int) -> Image.Image:
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


def load_source_master(min_size=512) -> Image.Image:
    """从 image.jpg 中定位圆形徽标（第一个高亮行带），裁成带圆角的方形 master 图。"""
    img = Image.open(SOURCE).convert('RGB')
    w, h = img.size
    mask = img.convert('L').point(lambda p: 255 if p > 70 else 0)
    px = mask.load()

    # 按行亮像素数分带：第一带=圆形徽标，其后是「推妖镜/BotZapper」文字带
    bands = []
    start = None
    for y in range(h):
        cnt = sum(1 for x in range(0, w, 4) if px[x, y])
        if cnt > 2 and start is None:
            start = y
        if cnt <= 2 and start is not None:
            if y - start > 40:
                bands.append((start, y))
            start = None
    if start is not None and h - start > 40:
        bands.append((start, h))
    if not bands:
        raise RuntimeError('未能在 image.jpg 中定位徽标')

    bbox = mask.crop((0, bands[0][0], w, bands[0][1])).getbbox()
    # bbox 是带内局部坐标，需加回带起点偏移
    cx = (bbox[0] + bbox[2]) / 2
    cy = bands[0][0] + (bbox[1] + bbox[3]) / 2
    side = max(bbox[2] - bbox[0], bbox[3] - bbox[1]) * 1.05  # 紧边距，小尺寸下笔画才够粗
    left = max(0, int(cx - side / 2))
    top_edge = max(0, int(cy - side / 2))
    right = min(w, int(cx + side / 2))
    bottom = min(h, int(cy + side / 2))
    crop = img.crop((left, top_edge, right, bottom))

    side = min(crop.size)  # 正方形化
    crop = crop.resize((side, side), Image.LANCZOS)
    if side < min_size:
        crop = crop.resize((min_size, min_size), Image.LANCZOS)
        side = min_size

    # 圆角遮罩（约 18% 圆角，贴合 Chrome 图标观感）
    mask_img = Image.new('L', (side, side), 0)
    ImageDraw.Draw(mask_img).rounded_rectangle([0, 0, side - 1, side - 1], radius=int(side * 0.18), fill=255)
    out = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    out.paste(crop, (0, 0), mask_img)
    return out


def main():
    os.makedirs(ICONS, exist_ok=True)
    if os.path.exists(SOURCE):
        master = load_source_master()
        for size in (16, 48, 128):
            icon = master.resize((size, size), Image.LANCZOS)
            if size <= 32:
                # 小尺寸下细线条易糊，锐化增粗观感
                icon = icon.filter(ImageFilter.UnsharpMask(radius=1, percent=90, threshold=1))
            path = os.path.join(ICONS, f'icon{size}.png')
            icon.save(path)
            print('wrote', path, '(from image.jpg)')
    else:
        for size in (16, 48, 128):
            path = os.path.join(ICONS, f'icon{size}.png')
            draw_placeholder(size).save(path)
            print('wrote', path, '(placeholder)')


if __name__ == '__main__':
    main()

