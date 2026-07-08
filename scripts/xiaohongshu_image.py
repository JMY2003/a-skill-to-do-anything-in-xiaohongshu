#!/usr/bin/env python3
"""Generate simple Xiaohongshu-friendly cover/card images.

This is deterministic image generation for title cards and carousel covers. For
photorealistic or illustrative AI images, use Codex/imagegen first, then pass the
resulting file path to xiaohongshu_package.py.
"""

from __future__ import annotations

import argparse
import math
import re
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


THEMES = {
    "coral": {"bg": "#fff7f2", "accent": "#ff4d6d", "text": "#28211f", "muted": "#7b6b65"},
    "mint": {"bg": "#effcf6", "accent": "#0f9f7a", "text": "#17352f", "muted": "#5c746e"},
    "ink": {"bg": "#f6f5ef", "accent": "#1f2937", "text": "#111827", "muted": "#6b7280"},
    "sky": {"bg": "#f2f8ff", "accent": "#2563eb", "text": "#172554", "muted": "#64748b"},
    "professional": {"bg": "#f8fafc", "accent": "#2563eb", "text": "#111827", "muted": "#64748b"},
    "retro": {"bg": "#fff4df", "accent": "#c2410c", "text": "#3b2416", "muted": "#8a5a35"},
    "terminal": {"bg": "#0d1117", "accent": "#39d353", "text": "#e6edf3", "muted": "#8b949e"},
    "sketch": {"bg": "#fbfaf7", "accent": "#3f3f46", "text": "#18181b", "muted": "#71717a"},
}


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/STHeiti Medium.ttc" if bold else "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size=size)
    return ImageFont.load_default()


def wrap_cjk(text: str, chars: int) -> list[str]:
    lines: list[str] = []
    for raw in text.splitlines() or [text]:
        raw = raw.strip()
        if not raw:
            lines.append("")
            continue
        if any("\u4e00" <= ch <= "\u9fff" for ch in raw):
            lines.extend([raw[i : i + chars] for i in range(0, len(raw), chars)])
        else:
            lines.extend(textwrap.wrap(raw, width=chars) or [raw])
    return lines


def draw_rounded_rect(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], radius: int, fill: str) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def create_cover(args: argparse.Namespace) -> None:
    width, height = map(int, args.size.lower().split("x", 1))
    theme = THEMES[args.theme]
    img = Image.new("RGB", (width, height), theme["bg"])
    draw = ImageDraw.Draw(img)

    margin = int(width * 0.075)
    accent_h = int(height * 0.018)
    draw_rounded_rect(draw, (margin, margin, width - margin, margin + accent_h), accent_h // 2, theme["accent"])

    title_font = font(args.title_size, bold=True)
    subtitle_font = font(args.subtitle_size)
    tag_font = font(args.tag_size, bold=True)

    y = int(height * 0.19)
    max_chars = max(8, math.floor((width - margin * 2) / (args.title_size * 0.58)))
    title_lines = wrap_cjk(args.title, max_chars)[:4]
    for line in title_lines:
        bbox = draw.textbbox((0, 0), line, font=title_font)
        draw.text((margin, y), line, fill=theme["text"], font=title_font)
        y += (bbox[3] - bbox[1]) + int(args.title_size * 0.22)

    if args.subtitle:
        y += int(height * 0.035)
        subtitle_chars = max(12, math.floor((width - margin * 2) / (args.subtitle_size * 0.58)))
        for line in wrap_cjk(args.subtitle, subtitle_chars)[:5]:
            bbox = draw.textbbox((0, 0), line, font=subtitle_font)
            draw.text((margin, y), line, fill=theme["muted"], font=subtitle_font)
            y += (bbox[3] - bbox[1]) + int(args.subtitle_size * 0.35)

    tags = [tag.strip().lstrip("#") for tag in args.tag or [] if tag.strip()]
    if tags:
        x = margin
        y = height - margin - int(args.tag_size * 2.2)
        for tag in tags[:5]:
            label = "#" + tag
            bbox = draw.textbbox((0, 0), label, font=tag_font)
            pad_x = int(args.tag_size * 0.65)
            pad_y = int(args.tag_size * 0.35)
            box_w = bbox[2] - bbox[0] + pad_x * 2
            box_h = bbox[3] - bbox[1] + pad_y * 2
            if x + box_w > width - margin:
                break
            draw_rounded_rect(draw, (x, y, x + box_w, y + box_h), box_h // 2, "#ffffff")
            draw.text((x + pad_x, y + pad_y - 2), label, fill=theme["accent"], font=tag_font)
            x += box_w + int(args.tag_size * 0.45)

    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    print(out)

def parse_markdown_card_source(path: Path) -> tuple[dict[str, str], str]:
    text = path.read_text(encoding="utf-8")
    meta: dict[str, str] = {}
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1:
            for line in text[4:end].splitlines():
                if ":" in line:
                    key, value = line.split(":", 1)
                    meta[key.strip()] = value.strip().strip("\"'")
            text = text[end + 5 :]
    return meta, text.strip()


def split_cards(body: str, mode: str, max_chars: int = 260) -> list[str]:
    if mode == "separator":
        parts = [p.strip() for p in body.split("\n---\n")]
        return [p for p in parts if p]

    cards: list[str] = []
    current: list[str] = []
    current_len = 0
    blocks = [b.strip() for b in re.split(r"\n\s*\n", body) if b.strip()]
    for block in blocks:
        projected = current_len + len(block)
        if current and projected > max_chars:
            cards.append("\n\n".join(current))
            current = [block]
            current_len = len(block)
        else:
            current.append(block)
            current_len = projected
    if current:
        cards.append("\n\n".join(current))
    return cards or [body]


def draw_multiline(draw: ImageDraw.ImageDraw, text: str, xy: tuple[int, int], max_chars: int, fill: str, text_font, line_gap: int, max_lines: int | None = None) -> int:
    x, y = xy
    lines: list[str] = []
    for raw in text.splitlines():
        lines.extend(wrap_cjk(raw, max_chars) if raw.strip() else [""])
    if max_lines:
        lines = lines[:max_lines]
    for line in lines:
        bbox = draw.textbbox((0, 0), line or " ", font=text_font)
        draw.text((x, y), line, fill=fill, font=text_font)
        y += (bbox[3] - bbox[1]) + line_gap
    return y


def create_text_card(out: Path, title: str, body: str, theme_name: str, size: str, index: int, total: int) -> None:
    width, height = map(int, size.lower().split("x", 1))
    theme = THEMES[theme_name]
    img = Image.new("RGB", (width, height), theme["bg"])
    draw = ImageDraw.Draw(img)
    margin = int(width * 0.075)

    title_font = font(58, bold=True)
    body_font = font(42)
    footer_font = font(28, bold=True)

    draw_rounded_rect(draw, (margin, margin, width - margin, margin + 16), 8, theme["accent"])
    y = int(height * 0.11)
    y = draw_multiline(draw, title, (margin, y), 16, theme["text"], title_font, 14, max_lines=2)
    y += 28
    draw_multiline(draw, body, (margin, y), 22, theme["text"], body_font, 18, max_lines=17)

    footer = f"{index}/{total}"
    bbox = draw.textbbox((0, 0), footer, font=footer_font)
    draw.text((width - margin - (bbox[2] - bbox[0]), height - margin - 40), footer, fill=theme["muted"], font=footer_font)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    print(out)


def create_carousel(args: argparse.Namespace) -> None:
    source = Path(args.markdown).expanduser()
    meta, body = parse_markdown_card_source(source)
    title = args.title or meta.get("title") or source.stem
    subtitle = args.subtitle or meta.get("subtitle") or ""
    out_dir = Path(args.out_dir).expanduser()
    cover_args = argparse.Namespace(
        title=title,
        subtitle=subtitle,
        tag=args.tag,
        size=args.size,
        theme=args.theme,
        title_size=args.title_size,
        subtitle_size=args.subtitle_size,
        tag_size=args.tag_size,
        out=str(out_dir / "cover.png"),
    )
    create_cover(cover_args)
    cards = split_cards(body, args.mode)
    for i, card in enumerate(cards, start=1):
        create_text_card(out_dir / f"card_{i}.png", title, card, args.theme, args.size, i, len(cards))


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate a Xiaohongshu cover/card PNG.")
    parser.add_argument("--title")
    parser.add_argument("--out")
    parser.add_argument("--markdown", help="Markdown file for cover + carousel cards.")
    parser.add_argument("--out-dir", help="Output directory for --markdown mode.")
    parser.add_argument("--mode", choices=["separator", "auto-split"], default="separator")
    parser.add_argument("--subtitle", default="")
    parser.add_argument("--tag", action="append")
    parser.add_argument("--size", default="1080x1440", help="Canvas size, e.g. 1080x1440 or 1080x1350.")
    parser.add_argument("--theme", choices=sorted(THEMES), default="coral")
    parser.add_argument("--title-size", type=int, default=88)
    parser.add_argument("--subtitle-size", type=int, default=42)
    parser.add_argument("--tag-size", type=int, default=34)
    args = parser.parse_args()
    if args.markdown:
        if not args.out_dir:
            parser.error("--markdown requires --out-dir")
        create_carousel(args)
    else:
        if not args.title or not args.out:
            parser.error("--title and --out are required unless --markdown is used")
        create_cover(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
