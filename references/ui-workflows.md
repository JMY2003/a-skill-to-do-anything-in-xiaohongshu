# Xiaohongshu Web Workflows

Use the web backend first: `scripts/xiaohongshu_web.mjs`. For anything beyond one diagnostic command, create a JSON plan and run it with `run-plan` so the browser session stays open.

## First Login

1. Detect browser:
   - `scripts/xiaohongshu_web.mjs detect-browser`
2. Open persistent login session:
   - `scripts/xiaohongshu_web.mjs login --browser default`
3. Complete login in the opened browser.
4. Reuse the same `--browser` value for later commands.

The saved session lives under `state/web/profiles/`. If Xiaohongshu expires the session, run `login` again.

Run `scripts/xiaohongshu_web.mjs status --browser default` before publishing, batch messaging, or other direct actions. Check both `loggedInLikely` and `block`; a nonzero cookie count is not enough because Xiaohongshu may redirect the creator center or notification page to login.

## Browser Selection

- `--browser default`: map the macOS default browser to the nearest Playwright backend.
- `--browser chrome`: use installed Google Chrome when available.
- `--browser chrome-canary`: use installed Google Chrome Canary when available.
- `--browser edge`: use installed Microsoft Edge when available.
- `--browser edge-canary`: use installed Microsoft Edge Canary when available.
- `--browser brave` or `arc`: use that Chromium-like app when available.
- `--browser firefox`: use Playwright Firefox.
- `--browser webkit` or `safari`: use Playwright WebKit.
- `--browser chromium`: use bundled Chromium.

## Search and Browse

```bash
scripts/xiaohongshu_web.mjs search "关键词" --browser default --limit 20 --out /tmp/results.json
scripts/xiaohongshu_web.mjs open-url "https://www.xiaohongshu.com/explore/..." --browser default
scripts/xiaohongshu_web.mjs run-plan /tmp/xiaohongshu-plan.json --browser default --out /tmp/xiaohongshu-plan-result.json
```

Search results are collected first from Xiaohongshu's `__INITIAL_STATE__` feed data, then from visible DOM links/cards. The extractor reads current camelCase fields such as `noteCard.displayTitle` and `user.nickName`; if titles are empty after a site update, run a small `evaluate` probe against `window.__INITIAL_STATE__` before changing selectors.

For multi-step search, note browsing, information collection, commenting, liking, favorites, notification interaction, and chat, load `operation-plans.md` and use `run-plan`.

When a control is not found, run a `diagnose` operation before changing selectors. Xiaohongshu often hides important controls inside custom elements or nested scroll containers.

## Generic DOM Operations

```bash
scripts/xiaohongshu_web.mjs click-text "发布" --browser default
scripts/xiaohongshu_web.mjs fill "textarea" "文本" --browser default
```

Use these when a specialized command needs adjustment for Xiaohongshu's current web UI.

## Chat

```bash
scripts/xiaohongshu_web.mjs message "好友名" "消息内容" --browser default --direct
```

The command opens the web notification/message area, clicks visible recipient text, fills the first editable field, and sends when `--direct` is supplied.

## Publishing

```bash
scripts/xiaohongshu_package.py create --topic TOPIC --out OUT_DIR --title TITLE --body BODY --hashtag TAG --image IMAGE
scripts/xiaohongshu_web.mjs publish OUT_DIR/post.json --browser default --direct
```

The command opens Xiaohongshu creator publish URL, uploads files if a file input is visible, fills the first editable field, and clicks a visible publish button when `--direct` is supplied.

Publishing may require scrolling internal creator-page containers and clicking/calling a custom `xhs-publish-btn` element. The web script includes this fallback and records `publishAttempt` plus `publishVerification` in the result.

## Batch Operations

For batch tasks, use a target file and call the web script per target. Write JSONL progress:

```json
{"target":"name or url","action":"message","status":"done","note":""}
```

Stop the batch if Xiaohongshu web shows a login, captcha, moderation, permission, or rate-limit block.

Prefer one `run-plan` with many operations over many separate CLI invocations. Chromium-like browsers also reuse the same CDP browser across commands, but a single plan is still faster and easier to audit.

## Session Management

```bash
scripts/xiaohongshu_web.mjs browser-status --browser default
scripts/xiaohongshu_web.mjs close-browser --browser default
```

`browser-status` reports whether the reusable CDP browser is already running. `close-browser` stops it when the user wants a clean end state.
