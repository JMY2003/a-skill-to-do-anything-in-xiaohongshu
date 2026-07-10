# DoAnythingInXiaohongshu

Xiaohongshu web automation skill for Codex and Claude Code.

This project turns Xiaohongshu's web UI into a scriptable, auditable automation layer for agents. It focuses on real browser operations instead of screenshot-based clicking: persistent login, reusable browser sessions, search and browsing, note extraction, comments, likes, favorites, notification/message interaction, image/card generation, and note publishing.

The durable entry point is:

```bash
scripts/xiaohongshu_web.mjs
```

For multi-step work, prefer:

```bash
scripts/xiaohongshu_web.mjs run-plan PLAN_JSON --browser default --direct
```

`run-plan` keeps one browser session alive, executes operations in order, and writes structured artifacts for every step. Interaction and publishing steps record `confirmed`, `unconfirmed`, or `blocked` evidence, so a UI click is never silently reported as a completed platform action.

## Why This Exists

Most browser automation breaks down when a platform changes layout, hides controls in custom elements, or opens permission/login prompts. This skill is built as a maintainable platform SDK:

- Persistent login profiles under `state/web/profiles/`
- Reusable CDP sessions for Chromium-like browsers
- A plan runner for multi-step tasks
- DOM diagnostics for missing controls, blocks, and nested scroll containers
- Feed/note extraction that prefers Xiaohongshu page state before DOM fallbacks
- Post packages and deterministic image/card generation for publishing workflows
- Artifacts for runs, steps, failures, and final results
- Completion verification that separates UI attempts from confirmed social actions

## Capabilities

- Search Xiaohongshu and collect visible note/profile information
- Open notes, browse feeds, scroll, and extract page state
- Comment, like, favorite/collect, and perform generic visible-text clicks
- Read notification/message surfaces and interact with visible recipients
- Generate image cards and build a post package
- Upload images, fill title/body/hashtags, and publish notes from Creator Center
- Execute batch or multi-step work through JSON operation plans
- Diagnose login, captcha, permission, moderation, rate-limit, and UI-change states

## Requirements

- Node.js 18+
- Python 3.9+
- A local browser supported by Playwright
- Playwright available either from Codex's bundled runtime or a local install

When running outside Codex, install Playwright in or near the repo:

```bash
npm install playwright
npx playwright install chromium
```

The skill can map the macOS default browser to the closest backend. It also supports explicit browser choices such as `chrome`, `chrome-canary`, `edge`, `edge-canary`, `brave`, `arc`, `firefox`, `webkit`, and `chromium`.

## Installation

For Codex, place or clone this repository under your skills directory:

```bash
mkdir -p ~/.codex/skills
git clone https://github.com/JMY2003/a-skill-to-do-anything-in-xiaohongshu.git \
  ~/.codex/skills/do-anything-in-xiaohongshu
```

If you already cloned it elsewhere, you can run the scripts directly from that checkout.

## Quick Start

Detect the browser backend:

```bash
scripts/xiaohongshu_web.mjs detect-browser
```

Login once:

```bash
scripts/xiaohongshu_web.mjs login --browser default
```

Complete login in the opened browser, then return to the terminal. Later commands reuse the saved profile.

Check session state:

```bash
scripts/xiaohongshu_web.mjs status --browser default
scripts/xiaohongshu_web.mjs browser-status --browser default
```

Search and export results:

```bash
scripts/xiaohongshu_web.mjs search "上海周末爵士酒吧" \
  --browser default \
  --limit 20 \
  --out /tmp/xiaohongshu-results.json
```

Open a URL:

```bash
scripts/xiaohongshu_web.mjs open-url "https://www.xiaohongshu.com/explore" --browser default
```

Send a direct message to a visible recipient:

```bash
scripts/xiaohongshu_web.mjs message "好友名" "测试信息" --browser default --direct
```

The command exits nonzero when delivery cannot be confirmed, while retaining the observed result for diagnosis.

Stop the reusable browser when you want a clean end state:

```bash
scripts/xiaohongshu_web.mjs close-browser --browser default
```

## Operation Plans

Use plans for real tasks. A plan runs inside one browser session and records structured artifacts.

```json
{
  "browser": "default",
  "account": "default",
  "out": "/tmp/xiaohongshu-plan-result.json",
  "artifactDir": "/tmp/xiaohongshu-artifacts",
  "operations": [
    { "action": "goto", "url": "https://www.xiaohongshu.com/explore" },
    { "action": "search", "query": "AI Agent 浏览器自动化", "limit": 20, "scrolls": 4 },
    { "action": "extract", "limit": 80 }
  ]
}
```

Run it:

```bash
scripts/xiaohongshu_web.mjs run-plan /tmp/xiaohongshu-plan.json \
  --browser default \
  --out /tmp/xiaohongshu-plan-result.json \
  --artifact-dir /tmp/xiaohongshu-artifacts
```

Common operation actions:

- `goto` / `open-url`
- `search`
- `extract` / `snapshot`
- `diagnose`
- `click-text`
- `click`
- `fill`
- `fill-first`
- `press`
- `comment`
- `like`
- `favorite` / `collect`
- `notification`
- `publish-package`
- `evaluate`
- `scroll`
- `scroll-containers`
- `wait`

See [references/operation-plans.md](references/operation-plans.md) for the full plan contract.

## Publishing Notes

Create deterministic image cards:

```bash
scripts/xiaohongshu_image.py \
  --title "Codex Skill 测试声明" \
  --subtitle "自动化发布流程测试" \
  --tag Codex测试 \
  --out /tmp/xiaohongshu-post/cover.png
```

Create a post package:

```bash
scripts/xiaohongshu_package.py create \
  --topic "Codex Skill 测试声明" \
  --out /tmp/xiaohongshu-post \
  --title "Codex Skill 测试声明" \
  --body "This is a Xiaohongshu automation test." \
  --hashtag Codex测试 \
  --image /tmp/xiaohongshu-post/cover.png
```

Inspect the package:

```bash
scripts/xiaohongshu_package.py show /tmp/xiaohongshu-post/post.json
```

Publish directly:

```bash
scripts/xiaohongshu_web.mjs publish /tmp/xiaohongshu-post/post.json \
  --browser default \
  --direct
```

A direct publish exits nonzero unless Creator Center reports that the note was submitted or published.

For more reliable publishing, especially when debugging Creator Center UI changes, run publishing through a plan:

```json
{
  "browser": "default",
  "account": "default",
  "out": "/tmp/xiaohongshu-publish-result.json",
  "artifactDir": "/tmp/xiaohongshu-publish-artifacts",
  "operations": [
    { "action": "diagnose", "limit": 120, "allowBlockedPage": true },
    {
      "action": "publish-package",
      "package": "/tmp/xiaohongshu-post/post.json",
      "direct": true,
      "uploadWaitMs": 12000
    }
  ]
}
```

## Multiple Accounts

Accounts are isolated by persistent profile path.

```bash
scripts/xiaohongshu_web.mjs accounts list
scripts/xiaohongshu_web.mjs accounts add work --alias "Work account"
scripts/xiaohongshu_web.mjs accounts default work
scripts/xiaohongshu_web.mjs login --browser default --account work
scripts/xiaohongshu_web.mjs run-plan /tmp/plan.json --browser default --account work
```

A reusable CDP browser is bound to one account/profile at a time. Close it before switching accounts on the same browser backend.

## Repository Layout

```text
.
├── SKILL.md
├── agents/
│   └── openai.yaml
├── references/
│   ├── content-publishing.md
│   ├── operation-plans.md
│   ├── sdk-architecture.md
│   └── ui-workflows.md
└── scripts/
    ├── xiaohongshu_web.mjs
    ├── xiaohongshu_package.py
    ├── xiaohongshu_image.py
    ├── sdk_selftest.mjs
    └── sdk/
        ├── account_manager.mjs
        ├── diagnostics.mjs
        ├── interaction_actions.mjs
        ├── plan_runner.mjs
        ├── runtime_guard.mjs
        ├── task_artifacts.mjs
        └── xiaohongshu_feed_explorer.mjs
```

Key modules:

- `scripts/xiaohongshu_web.mjs`: thin CLI and browser/session orchestration
- `scripts/sdk/account_manager.mjs`: account registry and profile paths
- `scripts/sdk/diagnostics.mjs`: blocks, snapshots, controls, custom elements, scroll containers
- `scripts/sdk/interaction_actions.mjs`: clicks and editable-field filling
- `scripts/sdk/plan_runner.mjs`: canonical multi-step executor
- `scripts/sdk/task_artifacts.mjs`: manifest, step records, final results, failure snapshots
- `scripts/sdk/xiaohongshu_feed_explorer.mjs`: search/feed extraction
- `scripts/xiaohongshu_package.py`: post package creation and inspection
- `scripts/xiaohongshu_image.py`: cover/card image generation

## Artifacts

`run-plan` writes:

- `manifest.json`
- `steps.jsonl`
- `steps/step-NNN.json`
- `step-N-failed.snapshot.json` or `step-N-blocked.snapshot.json`
- `step-N-unconfirmed.snapshot.json` when an interaction lacks completion evidence
- `result.json`

These files make long-running and batch tasks easier to audit and resume.

## Regression Checks

After changing SDK or CLI code, run:

```bash
node --check scripts/xiaohongshu_web.mjs
node --check scripts/sdk/account_manager.mjs
node --check scripts/sdk/diagnostics.mjs
node --check scripts/sdk/interaction_actions.mjs
node --check scripts/sdk/plan_runner.mjs
node --check scripts/sdk/task_artifacts.mjs
node --check scripts/sdk/xiaohongshu_feed_explorer.mjs
node scripts/sdk_selftest.mjs
scripts/xiaohongshu_web.mjs accounts list
```

## Web Authority Model

This skill operates through the Xiaohongshu web UI. It does not bypass Xiaohongshu login, captcha, moderation, permission prompts, rate limits, or feature availability. If the website blocks or rejects an action, the current command should stop and report the observed state.

Known web limits:

- Normal Xiaohongshu and Creator Center login state can expire independently.
- Creator Center can use nested scroll containers and a custom `xhs-publish-btn` submit element.
- Browser permission pages such as `edge://permission-request-dialog/` or `chrome://permission-request-dialog/` block automation until resolved.
- Some profile/following surfaces may not expose a reliable web route or DOM control at all times.
