#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountManager } from "./sdk/account_manager.mjs";
import { fillFirstVisible, clickAnyText, verifySemanticClick, verifyTextSubmission } from "./sdk/interaction_actions.mjs";
import { runPlan } from "./sdk/plan_runner.mjs";
import { acquireProcessLock } from "./sdk/runtime_guard.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function locatorList(items) {
  return {
    count: async () => items.length,
    nth: (index) => items[index],
  };
}

function field({ visible = true, writable = true, value = "" } = {}) {
  return {
    visible,
    value,
    async isVisible() {
      return this.visible;
    },
    async click() {},
    async fill(next) {
      if (!writable) throw new Error("not writable");
      this.value = next;
    },
    async evaluate(callback) {
      return callback({ value: this.value, innerText: this.value, textContent: this.value });
    },
  };
}

function textTarget({ visible = true, fails = false } = {}) {
  return {
    clicked: false,
    async isVisible() {
      return visible;
    },
    async click() {
      if (fails) throw new Error("click rejected");
      this.clicked = true;
    },
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xiaohongshu-sdk-selftest-"));
const accountManager = new AccountManager({ stateDir: tmp, platform: "xiaohongshu" });
accountManager.add("selftest", "Self Test");
accountManager.setDefault("selftest");

const hiddenField = field({ visible: false });
const visibleField = field();
const clickFails = textTarget({ fails: true });
const clickWorks = textTarget();
const interactionPage = {
  locator: () => locatorList([hiddenField, visibleField]),
  getByText: () => locatorList([clickWorks, clickFails]),
  keyboard: {
    press: async () => {},
    insertText: async () => {},
  },
  waitForTimeout: async () => {},
};
await fillFirstVisible(interactionPage, [".field"], "verified", "field");
assert(visibleField.value === "verified", "fillFirstVisible did not skip a hidden matching field");
const clickResult = await clickAnyText(interactionPage, ["test"], 0);
assert(clickResult.clicked && clickWorks.clicked, "clickAnyText did not continue after a failed visible click");
const missingSemanticEvidence = await verifySemanticClick({}, { clicked: true });
assert(missingSemanticEvidence.status === "unconfirmed", "a semantic click without a target must not be confirmed");
const emptySubmissionEvidence = await verifyTextSubmission({}, [], "");
assert(emptySubmissionEvidence.status === "unconfirmed", "an empty submission must not be confirmed");

const lockDir = path.join(tmp, "locks");
fs.mkdirSync(lockDir, { recursive: true });
fs.writeFileSync(path.join(lockDir, "selftest.lock"), "not-json", "utf8");
const releaseLock = acquireProcessLock({ lockDir, name: "selftest", label: "Xiaohongshu" });
releaseLock();
assert(!fs.existsSync(path.join(lockDir, "selftest.lock")), "stale lock was not released");

const fakePage = {
  url: () => "https://www.xiaohongshu.com/selftest",
  async evaluate() {
    return { body: "" };
  },
};
const launch = async () => ({
  browserName: "selftest",
  accountName: "selftest",
  context: {},
  cdp: false,
  cdpPort: null,
  cleanup: async () => {},
});
const common = {
  args: {},
  stateDir: tmp,
  platform: "xiaohongshu",
  launch,
  pageFor: async () => fakePage,
  safeCleanup: async (session) => session?.cleanup(),
};

const result = await runPlan({
  ...common,
  planPath: path.join(tmp, "plan.json"),
  plan: { browser: "selftest", account: "selftest", operations: [] },
  detectBlock: async () => null,
  runOperation: async () => {
    throw new Error("selftest should not run operations");
  },
});
assert(fs.existsSync(path.join(result.artifactDir, "result.json")), "missing success artifact result");

const blocked = await runPlan({
  ...common,
  planPath: path.join(tmp, "blocked-plan.json"),
  plan: { operations: [{ action: "like" }, { action: "comment" }] },
  detectBlock: async () => ({ type: "login", url: fakePage.url(), excerpt: "login" }),
  runOperation: async () => {
    throw new Error("blocked operation must not run");
  },
});
assert(blocked.counts.blocked === 1 && blocked.counts.skipped === 1, "blocked plans must report blocked and skipped counts");

const operationBlocked = await runPlan({
  ...common,
  planPath: path.join(tmp, "operation-blocked-plan.json"),
  plan: { operations: [{ action: "like" }, { action: "comment" }] },
  detectBlock: async () => null,
  runOperation: async () => ({ verification: { status: "blocked", reason: "platform rejected interaction" } }),
});
assert(operationBlocked.counts.blocked === 1 && operationBlocked.counts.done === 0 && operationBlocked.counts.skipped === 1, "operation-reported blocks must not be counted as done");

const unconfirmed = await runPlan({
  ...common,
  planPath: path.join(tmp, "unconfirmed-plan.json"),
  plan: { operations: [{ action: "like" }, { action: "comment" }] },
  detectBlock: async () => null,
  runOperation: async () => ({ verification: { status: "unconfirmed", reason: "no state change" } }),
});
assert(unconfirmed.counts.unconfirmed === 1 && unconfirmed.counts.done === 0 && unconfirmed.counts.skipped === 1, "unconfirmed operations must not be counted as done");

const confirmed = await runPlan({
  ...common,
  planPath: path.join(tmp, "confirmed-plan.json"),
  plan: { operations: [{ action: "like" }] },
  detectBlock: async () => null,
  runOperation: async () => ({ verification: { status: "confirmed" } }),
});
assert(confirmed.counts.done === 1 && confirmed.counts.unconfirmed === 0, "confirmed operations must be counted as done");

let continuedCalls = 0;
const continuedUnconfirmed = await runPlan({
  ...common,
  planPath: path.join(tmp, "continued-unconfirmed-plan.json"),
  plan: { operations: [{ action: "like", continueOnUnconfirmed: true }, { action: "diagnose" }] },
  detectBlock: async () => null,
  runOperation: async () => {
    continuedCalls += 1;
    return continuedCalls === 1
      ? { verification: { status: "unconfirmed", reason: "no state change" } }
      : { verification: { status: "confirmed" } };
  },
});
assert(continuedUnconfirmed.counts.unconfirmed === 1 && continuedUnconfirmed.counts.done === 1 && continuedUnconfirmed.counts.skipped === 0, "continueOnUnconfirmed must preserve the unconfirmed record and run later steps");

let failureArtifact = "";
try {
  await runPlan({
    ...common,
    planPath: path.join(tmp, "failed-plan.json"),
    plan: { operations: [{ action: "boom" }] },
    launch: async () => {
      throw new Error("expected launch failure");
    },
    detectBlock: async () => null,
    runOperation: async () => ({ ok: true }),
  });
} catch (err) {
  failureArtifact = err.artifactDir;
}
assert(failureArtifact && fs.existsSync(path.join(failureArtifact, "result.json")), "failed plans must retain artifacts");

console.log(JSON.stringify({ ok: true, tmp, artifactDir: result.artifactDir, account: accountManager.defaultAccount() }, null, 2));
