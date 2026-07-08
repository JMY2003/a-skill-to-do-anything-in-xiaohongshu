# Xiaohongshu Operation Plans

Use `scripts/xiaohongshu_web.mjs run-plan PLAN_JSON --browser default --direct --out RESULT_JSON` for multi-step Xiaohongshu work. A plan keeps one browser session alive, executes operations in order, records per-step results, and writes a run artifact directory.

## Why Plans

- Avoid repeated browser open/close cycles.
- Reuse the CDP browser session for Chromium-like browsers.
- Keep search, browse, extract, comment, like, favorite, notification, chat, and publish steps in one auditable run.
- Preserve account/profile isolation with top-level `account` or CLI `--account`.
- Keep failure evidence in `state/web/artifacts/...` instead of relying on memory from the live browser.
- Use `evaluate` only when Xiaohongshu's current DOM needs a custom browser-side script.

## Plan Shape

```json
{
  "browser": "default",
  "account": "default",
  "out": "/tmp/xiaohongshu-plan-result.json",
  "artifactDir": "/tmp/xiaohongshu-artifacts",
  "operations": [
    {"action": "goto", "url": "https://www.xiaohongshu.com/explore"},
    {"action": "search", "query": "上海周末爵士酒吧", "limit": 20, "scrolls": 4},
    {"action": "extract", "limit": 80}
  ]
}
```

Each operation result is written into `records[]` with `status`, `result`, and optional `error` or `block`. The artifact directory contains `manifest.json`, `steps.jsonl`, `steps/step-NNN.json`, final `result.json`, and DOM diagnostic snapshots for failed or blocked steps.

## Supported Operations

- `goto` / `open-url`: open a URL.
- `search`: open the search page, scroll, and collect notes/profile cards with `sourceSummary` and extractor `stateKeys`; the extractor prefers `window.__INITIAL_STATE__` before DOM fallbacks.
- `click-text`: click visible text. Use `exact: true` when needed.
- `click`: click a CSS selector.
- `fill`: fill a CSS selector.
- `fill-first`: fill the first visible editable field.
- `press`: press a keyboard key such as `Enter`.
- `comment`: fill the first editable field and press Enter when `--direct` or operation `direct: true` is set.
- `like`: click a visible like/upvote control by text.
- `favorite` / `collect`: click a visible collect/save/favorite control by text.
- `scroll`: scroll the page one or more times.
- `wait`: wait by milliseconds.
- `extract` / `snapshot`: return URL, title, body text, links, and visible editable fields.
- `diagnose`: return URL, title, body text, links, editables, visible controls, custom elements, internal scroll containers, and the current block state.
- `scroll-containers`: scroll every visible internal scroll container to the bottom. Use this before looking for controls that sit in Xiaohongshu's fixed or nested creator panels.
- `notification`: open `/notification` and extract the visible state.
- `publish-package`: publish a `xiaohongshu_package.py` JSON package.
- `evaluate`: run custom JavaScript in the page and return its value.

## Common Workflows

Search and collect information:

```json
{
  "operations": [
    {"action": "search", "query": "关键词", "limit": 30, "scrolls": 5},
    {"action": "extract", "limit": 120}
  ]
}
```

Comment and like a known note:

```json
{
  "operations": [
    {"action": "goto", "url": "https://www.xiaohongshu.com/explore/NOTE_ID?xsec_token=TOKEN&xsec_source=pc_feed"},
    {"action": "wait", "ms": 1500},
    {"action": "comment", "text": "写得很实用，感谢分享", "direct": true},
    {"action": "like"}
  ]
}
```

Interact from notifications:

```json
{
  "operations": [
    {"action": "notification", "limit": 120},
    {"action": "click-text", "text": "评论"},
    {"action": "extract", "limit": 120}
  ]
}
```

Publish content package:

```json
{
  "operations": [
    {"action": "diagnose", "limit": 120, "allowBlockedPage": true},
    {"action": "publish-package", "package": "/tmp/xiaohongshu-post/post.json", "direct": true}
  ]
}
```

## Web UI Notes From Current Exploration

- Creator publish can redirect to `https://creator.xiaohongshu.com/login?...redirectReason=401...` even when the normal web feed still has cookies. Treat this as login-expired and rerun `login`.
- Browser permission prompts can appear as `edge://permission-request-dialog/` or `chrome://permission-request-dialog/` with text like `想要 了解你的位置`. Treat them as blocking pages until resolved.
- The creator publish page uses internal scroll containers such as `.publish-page` and `.publish-page-content`; scroll the containers, not only the window, before looking for bottom controls.
- The final publish control can be a custom element named `xhs-publish-btn` with attributes like `submit-text="发布"` and `submit-disabled="false"`. The script calls its internal publish handler when available, then falls back to host/button clicks.
- Use `diagnose` after unexpected failures. If a selector fails, inspect `customElements`, `controls`, and `scrollables` in the result before changing the plan.

## Known Web Limits

The current Xiaohongshu web profile page may show follower/following counts as plain text without exposing a clickable following-list view. Do not promise a web following-list operation until the current site exposes a working route, API, or DOM control.
