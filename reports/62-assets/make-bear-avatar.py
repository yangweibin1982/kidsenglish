# -*- coding: utf-8 -*-
"""生成原创 128x128 蜡笔风小熊头像（票 62 开源化：替换 freddy.png 的原创替代形象）。
形状全原创：棕熊脸＋浅吻部＋黑圆眼＋腮红＋微笑，厚描边＝美术圣经案 C 蜡笔风。
运行：python -X utf8 make-bear-avatar.py（需 Pillow；输出覆盖 ../assets/avatars/freddy.png 路径参 src 变量）"""
from PIL import Image, ImageDraw

S = 128
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

INK = (58, 63, 74, 255)        # ke-ink 暖棕深墨（圣经 §2.1）
BROWN = (0xb5, 0x8a, 0x5a, 255)
BROWN_DARK = (0x8f, 0x6a, 0x42, 255)
CREAM = (0xf2, 0xdf, 0xc2, 255)
BLUSH = (0xe8, 0x9a, 0x8a, 200)
WHITE = (255, 255, 255, 255)
BLACK = (43, 47, 56, 255)

def circle(cx, cy, r, fill, outline=None, w=0):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill, outline=outline, width=w)

# 耳朵（双圆＋内耳）
for sx in (-1, 1):
    cx, cy = 64 + sx * 34, 34
    circle(cx, cy, 16, BROWN, INK, 4)
    circle(cx, cy, 7, BROWN_DARK)
# 头（大圆＋厚描边）
circle(64, 70, 46, BROWN, INK, 5)
# 吻部（奶油椭圆）
d.ellipse([64 - 26, 70 - 6, 64 + 26, 70 + 30], fill=CREAM, outline=INK, width=3)
# 鼻（小圆）＋嘴（微笑弧）
circle(64, 78, 6, BLACK)
d.arc([64 - 14, 74, 64 + 14, 96], 25, 155, fill=INK, width=4)
# 眼（双黑圆＋白高光）
for sx in (-1, 1):
    cx, cy = 64 + sx * 18, 60
    circle(cx, cy, 6, BLACK)
    circle(cx - 2, cy - 2, 2, WHITE)
# 腮红
for sx in (-1, 1):
    d.ellipse([64 + sx * 32 - 8, 76 - 5, 64 + sx * 32 + 8, 76 + 5], fill=BLUSH)
# 眉弓点（蜡笔感小点两粒）
for sx in (-1, 1):
    d.ellipse([64 + sx * 18 - 2, 46 - 2, 64 + sx * 18 + 2, 46 + 2], fill=BROWN_DARK)

img.save(r"client/app/src/assets/avatars/freddy.png")  # 仓根相对路径（cwd=repo root）
print("saved", img.size)
