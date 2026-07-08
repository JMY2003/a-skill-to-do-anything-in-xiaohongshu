import fs from "node:fs";
import path from "node:path";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function safeName(value) {
  return String(value || "run").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "run";
}

export class TaskArtifacts {
  constructor({ stateDir, platform, command, planPath = "", outDir = "" }) {
    this.platform = platform;
    this.command = command || "command";
    this.runDir = outDir
      ? path.resolve(outDir)
      : path.join(stateDir, "artifacts", `${stamp()}-${safeName(command)}-${process.pid}`);
    ensureDir(this.runDir);
    this.writeJson("manifest.json", {
      platform,
      command,
      planPath: planPath ? path.resolve(planPath) : "",
      pid: process.pid,
      cwd: process.cwd(),
      startedAt: new Date().toISOString(),
    });
  }

  writeJson(name, data) {
    const file = path.join(this.runDir, name);
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
    return file;
  }

  appendJsonl(name, data) {
    const file = path.join(this.runDir, name);
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, JSON.stringify(data) + "\n", "utf8");
    return file;
  }

  async capturePage(page, name = "page", limit = 120) {
    const snapshot = await page.evaluate((limit) => {
      const clean = (text) => (text || "").replace(/\s+/g, " ").trim();
      const visible = (el) => el instanceof HTMLElement && (el.offsetParent !== null || el.getClientRects().length > 0);
      const controls = [...document.querySelectorAll("button,[role='button'],a[href],input,textarea,[contenteditable='true'],[aria-label]")]
        .filter(visible)
        .slice(0, limit)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          text: clean(el.innerText || el.textContent || el.value || el.getAttribute("aria-label") || "").slice(0, 160),
          href: el.href || "",
          aria: el.getAttribute("aria-label") || "",
          placeholder: el.getAttribute("placeholder") || "",
        }));
      return {
        url: location.href,
        title: document.title,
        body: clean(document.body?.innerText || "").slice(0, 4000),
        controls,
      };
    }, limit);
    this.writeJson(`${safeName(name)}.snapshot.json`, snapshot);
    return snapshot;
  }

  finalize(result) {
    const finishedAt = new Date().toISOString();
    this.writeJson("result.json", { ...result, artifactDir: this.runDir, finishedAt });
    return this.runDir;
  }
}
