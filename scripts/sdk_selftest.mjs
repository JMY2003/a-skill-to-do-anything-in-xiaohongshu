#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountManager } from "./sdk/account_manager.mjs";
import { runPlan } from "./sdk/plan_runner.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xiaohongshu-sdk-selftest-"));
const accountManager = new AccountManager({ stateDir: tmp, platform: "xiaohongshu" });
accountManager.add("selftest", "Self Test");
accountManager.setDefault("selftest");

const fakePage = {
  url: () => "https://www.xiaohongshu.com/selftest",
  async evaluate() {
    return "";
  },
};

const result = await runPlan({
  planPath: path.join(tmp, "plan.json"),
  plan: { browser: "selftest", account: "selftest", operations: [] },
  args: {},
  stateDir: tmp,
  platform: "xiaohongshu",
  launch: async () => ({
    browserName: "selftest",
    accountName: "selftest",
    context: {},
    cdp: false,
    cdpPort: null,
    cleanup: async () => {},
  }),
  pageFor: async () => fakePage,
  detectBlock: async () => null,
  runOperation: async () => {
    throw new Error("selftest should not run operations");
  },
  safeCleanup: async (session) => session.cleanup(),
});

const artifactResult = path.join(result.artifactDir, "result.json");
if (!fs.existsSync(artifactResult)) {
  throw new Error(`Missing artifact result: ${artifactResult}`);
}

console.log(JSON.stringify({ ok: true, tmp, artifactDir: result.artifactDir, account: accountManager.defaultAccount() }, null, 2));
