# Xiaohongshu SDK Architecture

Use this reference when extending or repairing the Xiaohongshu automation backend.

## Module Boundaries

- `scripts/xiaohongshu_web.mjs`: thin CLI command dispatch. Keep durable behavior here, not platform logic.
- `scripts/sdk/account_manager.mjs`: account registry, default account, and isolated persistent profile paths.
- `scripts/sdk/diagnostics.mjs`: DOM snapshots, block detection, permission/login/rate-limit diagnosis, and scroll-container handling.
- `scripts/sdk/interaction_actions.mjs`: visible text clicks, semantic control clicks, and editable-field filling.
- `scripts/sdk/plan_runner.mjs`: canonical multi-step execution engine, artifact writing, failure snapshots, block handling, and final counts.
- `scripts/sdk/task_artifacts.mjs`: per-run manifest, step JSON, step JSONL, final result, and DOM diagnostic snapshots on failures or blocks.
- `scripts/sdk/xiaohongshu_feed_explorer.mjs`: search/feed/note card extraction. Prefer `window.__INITIAL_STATE__` note/feed data first, then visible DOM fallbacks.
- `scripts/xiaohongshu_package.py`: post package creation and inspection.
- `scripts/xiaohongshu_image.py`: deterministic cover/card generation.
- `scripts/xiaohongshu_app.py`: legacy native-app fallback only.

## Extension Rules

- Keep `xiaohongshu_web.mjs` as a thin shell. Add repeated browser, account, artifact, explorer, publishing, notification, or message logic to SDK modules first.
- Prefer better SDK boundaries over internal backward compatibility. Preserve user-facing command intent when practical, but do not keep old internal structures when they block a cleaner platform SDK.
- Add a structured source marker to extracted data, such as `initial-state`, `network`, `dom-anchor`, or `dom-virtual-card`.
- Prefer `window.__INITIAL_STATE__`, creator APIs available in page context, or network payload extraction over brittle visible-text scraping.
- When adding a new named account, require `--account NAME`; if a reusable CDP browser is already running for another account, close it before reusing the same browser backend.
- For every multi-step job, keep `run-plan` as the user-facing operation and write artifacts. Do not create one-off shell loops that bypass result recording.

## Artifacts

`run-plan` creates `state/web/artifacts/<timestamp>-run-plan-<pid>/` unless `--artifact-dir` or plan `artifactDir` is provided.

Artifacts include:

- `manifest.json`: command, plan path, pid, cwd, and start time.
- `steps.jsonl`: start and completion event records.
- `steps/step-NNN.json`: final per-step record.
- `step-N-failed.snapshot.json` or `step-N-blocked.snapshot.json`: DOM-level evidence when an operation fails or a web block appears.
- `result.json`: final result, counts, browser, account, URL, and artifact path.

## Account Commands

```bash
scripts/xiaohongshu_web.mjs accounts list
scripts/xiaohongshu_web.mjs accounts add work --alias "Work account"
scripts/xiaohongshu_web.mjs accounts default work
scripts/xiaohongshu_web.mjs login --browser default --account work
scripts/xiaohongshu_web.mjs run-plan /tmp/plan.json --browser default --account work
```

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
