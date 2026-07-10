#!/usr/bin/env python3
"""Create and inspect Xiaohongshu post packages for web publishing."""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime
from pathlib import Path


def normalize_tags(raw_tags: list[str]) -> list[str]:
    tags: list[str] = []
    for item in raw_tags:
        for part in re.split(r"[,，\s]+", item):
            tag = part.strip().lstrip("#")
            if tag and tag not in tags:
                tags.append(tag)
    return tags[:8]


def local_paths(raw_paths: list[str], label: str) -> list[str]:
    paths = [Path(item).expanduser() for item in raw_paths]
    missing = [str(path) for path in paths if not path.is_file()]
    if missing:
        raise ValueError(f"Missing {label} file(s): {', '.join(missing)}")
    return [str(path) for path in paths]


def draft_body(topic: str, audience: str, tone: str, angle: str) -> str:
    hook = angle or f"{topic}，我整理了一版可以直接参考的要点"
    return "\n".join(
        [
            hook,
            "",
            f"适合人群：{audience}" if audience else "适合想快速了解重点的人。",
            "",
            "几个重点：",
            f"1. 先明确自己的需求，再判断{topic}是否匹配。",
            "2. 不只看单个评价，尽量对比多个来源和真实使用场景。",
            "3. 做决定前，把预算、时间、风险和替代方案都列出来。",
            "",
            "简单说：别被单一信息带着走，先把关键条件摆清楚。",
            "",
            f"语气参考：{tone}" if tone else "",
        ]
    ).strip()


def make_package(args: argparse.Namespace) -> dict:
    tags = normalize_tags(args.hashtag or [])
    if not tags:
        tags = normalize_tags([args.topic, "经验分享", "小红书笔记"])
    title = args.title or f"{args.topic}｜一版快速参考"
    body = args.body or draft_body(args.topic, args.audience or "", args.tone or "自然、真实、简洁", args.angle or "")
    return {
        "title": title,
        "body": body,
        "hashtags": tags,
        "images": local_paths(args.image or [], "image"),
        "image_prompts": args.image_prompt or [],
        "settings": {
            "location": args.location or "",
            "visibility": args.visibility or "",
        },
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }


def render_markdown(data: dict) -> str:
    lines = [
        "# Xiaohongshu Post Package",
        "",
        f"Title: {data['title']}",
        "",
        "Body:",
        data["body"],
        "",
        "Hashtags:",
        " ".join("#" + tag.lstrip("#") for tag in data.get("hashtags", [])),
        "",
        "Images:",
    ]
    images = data.get("images") or []
    lines.extend([f"- {path}" for path in images] or ["- none"])
    prompts = data.get("image_prompts") or []
    if prompts:
        lines.extend(["", "Image prompts:"])
        lines.extend([f"- {prompt}" for prompt in prompts])
    settings = data.get("settings") or {}
    lines.extend(["", "Settings:"])
    lines.extend([f"- {key}: {value or 'not set'}" for key, value in settings.items()])
    return "\n".join(lines) + "\n"


def cmd_create(args: argparse.Namespace) -> None:
    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    data = make_package(args)
    json_path = out_dir / "post.json"
    md_path = out_dir / "post.md"
    json_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    md_path.write_text(render_markdown(data), encoding="utf-8")
    print(json_path)
    print(md_path)


def cmd_show(args: argparse.Namespace) -> None:
    data = json.loads(Path(args.package).expanduser().read_text(encoding="utf-8"))
    print(render_markdown(data))


def main() -> int:
    parser = argparse.ArgumentParser(description="Create or inspect a Xiaohongshu post package.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    create = sub.add_parser("create", help="Create post.json and post.md.")
    create.add_argument("--topic", required=True)
    create.add_argument("--out", required=True)
    create.add_argument("--title")
    create.add_argument("--body")
    create.add_argument("--audience")
    create.add_argument("--tone")
    create.add_argument("--angle")
    create.add_argument("--hashtag", action="append")
    create.add_argument("--image", action="append")
    create.add_argument("--image-prompt", action="append")
    create.add_argument("--location")
    create.add_argument("--visibility")
    create.set_defaults(func=cmd_create)

    show = sub.add_parser("show", help="Render an existing package as markdown.")
    show.add_argument("package")
    show.set_defaults(func=cmd_show)

    args = parser.parse_args()
    try:
        args.func(args)
    except ValueError as exc:
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
