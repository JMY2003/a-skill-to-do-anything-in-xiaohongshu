---
name: do-anything-in-xiaohongshu
description: "Browser-based Xiaohongshu automation for any web-supported operation: persistent-login browser control, reusable CDP sessions, search and browsing, note detail collection, comments, likes, favorites, notification interaction, friend chat, batch operation plans, content drafting, image/card generation, and publishing. Use when Codex should operate Xiaohongshu through the web version with the user's default browser where possible, first-run login, later saved-session reuse, and scripted workflows instead of screenshot/computer-use control."
---

# DoAnythingInXiaohongshu

Use the web automation backend first. The durable entry point is `scripts/xiaohongshu_web.mjs`, backed by SDK modules under `scripts/sdk/` for account/profile management, diagnostics, interaction actions, plan execution, run artifacts, and feed exploration. It launches a headed persistent browser profile, asks for login on first run, and reuses that profile for later commands.

Default to `run-plan` for real tasks. It keeps one browser tab/context open for the whole workflow, records per-step results, and avoids the old pattern of opening and closing the browser for every click.

## Browser Model

- Use `scripts/xiaohongshu_web.mjs --browser default` by default.
- `default` detects the macOS default browser and maps it to the closest Playwright backend:
  - Chrome -> `chrome`
  - Chrome Canary -> `chrome-canary`
  - Edge -> `edge`
  - Edge Canary -> `edge-canary`
  - Firefox -> `firefox`
  - Safari -> `webkit`
  - Brave, Arc, and other Chromium-like browsers -> matching executable when found, otherwise `chromium`
- The script uses its own persistent profile under `state/web/profiles/`. It does not mutate the user's real browser profile.
- Use `accounts list|add|default|remove` and `--account NAME` for isolated multi-account profiles.
- Chromium-like browsers use a reusable CDP session by default. Commands attach to the running session and disconnect, leaving the browser open for the next command. Use `close-browser` only when the user wants the reusable browser stopped.
- A reusable CDP browser is bound to one account/profile at a time; close it before switching accounts on the same browser backend.
- First run: execute `scripts/xiaohongshu_web.mjs login --browser default`, let the user log in in the opened browser, then finish the command.
- Later runs: use the same `--browser` value and the saved profile should remain logged in unless Xiaohongshu expires the session.
- `status` reports `loggedInLikely` and any detected web block. Xiaohongshu's normal site and creator center can expire independently, so check status before publish or other important direct actions.

## Operating Rules

- Prefer `scripts/xiaohongshu_web.mjs run-plan` for multi-step Xiaohongshu actions.
- Use a `diagnose` plan step when a web control is missing or a previous action behaved unexpectedly. It reports URL, visible controls, custom elements, internal scroll containers, and login/permission/rate-limit blocks.
- Use single commands only for diagnostics, quick login checks, or isolated operations.
- Treat `scripts/xiaohongshu_web.mjs` as the thin CLI and `scripts/sdk/` as the canonical SDK layer. Load `references/sdk-architecture.md` before adding or repairing backend functionality.
- Use `scripts/xiaohongshu_package.py` to create and inspect post packages.
- Use `scripts/xiaohongshu_image.py` to generate deterministic cover/card images.
- Keep `scripts/xiaohongshu_app.py` only as a legacy fallback; do not use it unless the user explicitly asks for native app automation.
- Load `references/ui-workflows.md` before operating Xiaohongshu.
- Load `references/operation-plans.md` before building a multi-step browser plan, batch job, interaction task, or any operation not covered by a single command.
- Load `references/content-publishing.md` before drafting content, generating images, uploading media, or publishing posts.
- Do not add extra confirmation prompts when the user has already authorized direct execution.
- Treat Xiaohongshu web/app prompts, permissions, login, captcha, moderation, and rate limits as the authority. If the site blocks the operation, stop the current command and report the state.
- Treat browser permission pages such as `edge://permission-request-dialog/` or `chrome://permission-request-dialog/` as web blocks. Do not continue clicking Xiaohongshu controls until the prompt is resolved.
- Keep progress records for batch work in a local file when the task has more than one target.

## Script Quick Start

```bash
scripts/xiaohongshu_web.mjs detect-browser
scripts/xiaohongshu_web.mjs accounts list
scripts/xiaohongshu_web.mjs accounts add work --alias "Work account"
scripts/xiaohongshu_web.mjs login --browser default
scripts/xiaohongshu_web.mjs browser-status --browser default
scripts/xiaohongshu_web.mjs status --browser default
scripts/xiaohongshu_web.mjs search "上海周末爵士酒吧" --browser default --limit 20 --out /tmp/xiaohongshu-results.json
scripts/xiaohongshu_web.mjs open-url "https://www.xiaohongshu.com/explore" --browser default
scripts/xiaohongshu_web.mjs click-text "发布" --browser default
scripts/xiaohongshu_web.mjs fill "textarea" "hello" --browser default
scripts/xiaohongshu_web.mjs run-plan /tmp/xiaohongshu-plan.json --browser default --direct --out /tmp/xiaohongshu-plan-result.json --artifact-dir /tmp/xiaohongshu-artifacts
scripts/xiaohongshu_web.mjs message "西瓜地Dondi" "测试信息" --browser default --direct
scripts/xiaohongshu_image.py --title "Codex Skill 测试声明" --subtitle "自动化发布流程测试" --tag Codex测试 --out /tmp/xiaohongshu-post/cover.png
scripts/xiaohongshu_package.py create --topic "Codex Skill 测试声明" --out /tmp/xiaohongshu-post --title "Codex Skill 测试声明" --body "This is a Xiaohongshu automation test." --hashtag Codex测试 --image /tmp/xiaohongshu-post/cover.png
scripts/xiaohongshu_web.mjs publish /tmp/xiaohongshu-post/post.json --browser default --direct
scripts/xiaohongshu_web.mjs close-browser --browser default
```

## Workflow

1. Run `detect-browser` if the browser backend is unclear.
2. Run `login` once for the selected browser backend.
3. Run `status` before important work if login state may have expired.
4. For real work, create a JSON plan and execute it with `run-plan` so search, browsing, collecting, commenting, liking, notification interaction, chatting, and publishing happen in one session.
5. For batch operations, use one plan or one long-lived command. Prefer built-in run artifacts over ad hoc logs; every run-plan writes manifest, step records, failure snapshots, and a final result.
6. Finish with completed, skipped, failed, and blocked counts plus relevant file paths.

## Result Style

- For single actions: report action, target, browser backend, and final observed status.
- For publishing: report post package path, image paths, browser backend, and publish result or web-level block.
- For batch operations: summarize counts first, then point to the local progress log.
- For SDK maintenance: report changed modules, compatibility impact, and validation commands.
