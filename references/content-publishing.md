# Xiaohongshu Web Content Publishing

Use `scripts/xiaohongshu_package.py`, `scripts/xiaohongshu_image.py`, and `scripts/xiaohongshu_web.mjs publish`.

## Package

```bash
scripts/xiaohongshu_package.py create --topic TOPIC --out OUT_DIR --title TITLE --body BODY --hashtag TAG --image IMAGE
scripts/xiaohongshu_package.py show OUT_DIR/post.json
```

## Image Cards

```bash
scripts/xiaohongshu_image.py --title TITLE --subtitle SUBTITLE --tag TAG --out OUT_DIR/cover.png
scripts/xiaohongshu_image.py --markdown OUT_DIR/cards.md --out-dir OUT_DIR --theme sketch --mode auto-split
```

Use the first form for a fast single cover. Use the Markdown form for a full carousel package:

```markdown
---
title: "封面标题"
subtitle: "封面副标题"
---

# 第一张正文卡片

---

# 第二张正文卡片
```

Themes: `coral`, `mint`, `ink`, `sky`, `professional`, `retro`, `terminal`, `sketch`.
Modes: `separator` for manual `---` page breaks, `auto-split` for paragraph-based splitting.

For AI-generated bitmap images, generate the image separately, save it locally, and pass the path into `xiaohongshu_package.py`.

## Publish

```bash
scripts/xiaohongshu_web.mjs login --browser default
scripts/xiaohongshu_web.mjs publish OUT_DIR/post.json --browser default --direct
scripts/xiaohongshu_web.mjs run-plan OUT_DIR/publish-plan.json --browser default --direct --out OUT_DIR/publish-result.json
```

The publish command and `run-plan` use the saved browser profile. Prefer `run-plan` when publishing is part of a larger task, such as drafting cards, uploading media, extracting the final page state, and recording a result.

Before publishing, `status` should show no login block. The normal Xiaohongshu site and the creator center can expire independently; a creator redirect with `redirectReason=401` means the browser profile needs login again.

The current creator page is not a plain HTML form. It can use:

- nested scroll containers such as `.publish-page` and `.publish-page-content`
- a custom final submit element, `xhs-publish-btn`, instead of a normal `button`
- browser-level permission prompts such as location permission in an `edge://permission-request-dialog/` or `chrome://permission-request-dialog/` page

The script handles this by scrolling internal containers, checking for web blocks, and calling the `xhs-publish-btn` publish handler when available. If publishing fails, run a plan with `diagnose` and inspect `customElements`, `controls`, `scrollables`, `block`, and `publishVerification`.
