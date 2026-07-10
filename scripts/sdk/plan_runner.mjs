import path from "node:path";
import fs from "node:fs";
import { TaskArtifacts } from "./task_artifacts.mjs";

export async function runPlan({
  planPath,
  plan,
  args,
  stateDir,
  platform,
  launch,
  pageFor,
  detectBlock,
  runOperation,
  safeCleanup,
}) {
  const artifacts = new TaskArtifacts({
    stateDir,
    platform,
    command: "run-plan",
    planPath,
    outDir: args["artifact-dir"] || args.artifactDir || plan.artifactDir || "",
  });
  const records = [];
  let session = null;
  let page = null;
  const counts = () => ({
    done: records.filter((record) => record.status === "done").length,
    failed: records.filter((record) => record.status === "failed").length,
    blocked: records.filter((record) => record.status === "blocked").length,
    unconfirmed: records.filter((record) => record.status === "unconfirmed").length,
    skipped: Math.max(0, plan.operations.length - records.length),
  });
  try {
    session = await launch(plan.browser || args.browser, plan.account || args.account);
    page = await pageFor(session.context);
    for (let i = 0; i < plan.operations.length; i++) {
      const op = plan.operations[i];
      const record = { index: i, action: op.action || op.type, status: "running", startedAt: new Date().toISOString() };
      records.push(record);
      artifacts.appendJsonl("steps.jsonl", { ...record, event: "start" });
      try {
        const blockBefore = await detectBlock(page);
        const actionName = op.action || op.type;
        const navigatesFirst = ["goto", "open-url", "open_url", "search", "notification", "notifications", "publish-package", "publish_package"].includes(actionName);
        if (blockBefore && !op.allowBlockedPage && !navigatesFirst) {
          record.status = "blocked";
          record.block = blockBefore;
          await artifacts.capturePage(page, `step-${i}-blocked`, Number(op.diagnosticLimit || 120)).catch(() => null);
          break;
        }
        record.result = await runOperation(page, op, args, i);
        const verification = record.result?.verification;
        if (verification?.status === "blocked") {
          record.status = "blocked";
          record.block = verification.block || { type: "operation-blocked", excerpt: verification.reason || "operation reported a block" };
          await artifacts.capturePage(page, `step-${i}-blocked`, Number(op.diagnosticLimit || 120)).catch(() => null);
          break;
        }
        if (verification?.status === "unconfirmed") {
          record.status = "unconfirmed";
          record.verification = verification;
          await artifacts.capturePage(page, `step-${i}-unconfirmed`, Number(op.diagnosticLimit || 120)).catch(() => null);
          if (!op.continueOnUnconfirmed) break;
          continue;
        }
        const blockAfter = await detectBlock(page);
        if (blockAfter && !op.allowBlockedPage) {
          record.status = "blocked";
          record.block = blockAfter;
          await artifacts.capturePage(page, `step-${i}-blocked`, Number(op.diagnosticLimit || 120)).catch(() => null);
          break;
        }
        record.status = "done";
      } catch (err) {
        record.status = "failed";
        record.error = err.message;
        await artifacts.capturePage(page, `step-${i}-failed`, Number(op.diagnosticLimit || 120)).catch(() => null);
        if (!op.continueOnError) break;
      } finally {
        record.finishedAt = new Date().toISOString();
        artifacts.writeJson(`steps/step-${String(i).padStart(3, "0")}.json`, record);
        artifacts.appendJsonl("steps.jsonl", { ...record, event: "finish" });
      }
    }
    const result = {
      browser: session.browserName,
      session: session.cdp ? "cdp-reused-browser" : "single-command-browser",
      cdpPort: session.cdpPort || null,
      account: session.accountName,
      plan: path.resolve(planPath),
      url: page.url(),
      records,
      counts: counts(),
    };
    artifacts.finalize(result);
    result.artifactDir = artifacts.runDir;
    const text = JSON.stringify(result, null, 2);
    if (args.out || plan.out) fs.writeFileSync(path.resolve(args.out || plan.out), text + "\n", "utf8");
    return result;
  } catch (err) {
    const result = {
      browser: session?.browserName || "",
      session: session?.cdp ? "cdp-reused-browser" : session ? "single-command-browser" : "not-started",
      cdpPort: session?.cdpPort || null,
      account: session?.accountName || "",
      plan: path.resolve(planPath),
      url: page?.url?.() || "",
      records,
      counts: counts(),
      error: err.message,
    };
    artifacts.finalize(result);
    err.artifactDir = artifacts.runDir;
    throw err;
  } finally {
    await safeCleanup(session);
  }
}
