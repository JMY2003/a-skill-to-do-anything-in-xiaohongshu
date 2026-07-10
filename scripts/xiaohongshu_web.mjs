#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import { AccountManager } from "./sdk/account_manager.mjs";
import { collectXiaohongshuFeedItems } from "./sdk/xiaohongshu_feed_explorer.mjs";
import {
  pageSnapshot as sdkPageSnapshot,
  detectBlock as sdkDetectBlock,
  assertNotBlocked as sdkAssertNotBlocked,
  scrollAllContainers as sdkScrollAllContainers,
} from "./sdk/diagnostics.mjs";
import {
  fillFirstVisible as sdkFillFirstVisible,
  fillFirstEditable as sdkFillFirstEditable,
  clickAnyText as sdkClickAnyText,
  clickSemanticControl as sdkClickSemanticControl,
  verifySemanticClick as sdkVerifySemanticClick,
  verifyTextSubmission as sdkVerifyTextSubmission,
} from "./sdk/interaction_actions.mjs";
import { runPlan as sdkRunPlan } from "./sdk/plan_runner.mjs";
import { acquireProcessLock, probeCdpEndpoint, validateCdpOwnership } from "./sdk/runtime_guard.mjs";

const SKILL_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const STATE_DIR = path.join(SKILL_DIR, "state", "web");
const LOCK_DIR = path.join(STATE_DIR, "locks");
const ACCOUNT_MANAGER = new AccountManager({ stateDir: STATE_DIR, platform: "xiaohongshu" });
const MUTATING_COMMANDS = new Set(["login", "status", "open-url", "search", "click-text", "fill", "message", "publish", "run-plan", "close-browser", "accounts"]);
const DEFAULT_NODE_MODULES = path.join(
  os.homedir(),
  ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules"
);

function loadPlaywright() {
  try {
    const req = createRequire(import.meta.url);
    return req("playwright");
  } catch (_) {
    const req = createRequire(path.join(DEFAULT_NODE_MODULES, "xiaohongshu-web-loader.js"));
    return req("playwright");
  }
}

const { chromium, firefox, webkit } = loadPlaywright();

const CDP_PORTS = {
  chromium: 9320,
  chrome: 9321,
  "chrome-canary": 9322,
  edge: 9323,
  "edge-canary": 9324,
  brave: 9325,
  arc: 9326,
};

const BLOCK_RULES = [
  {
    type: "permission",
    url: /^(edge|chrome):\/\/permission-request-dialog/i,
    text: /想要.*(位置|通知|摄像头|麦克风)|阻止\s*允许|Block\s*Allow/i,
  },
  {
    type: "login",
    url: /\/login\b|redirectReason=401|login\?redirectPath/i,
    text: /手机号登录|短信登录|扫码登录|获取验证码|登录后推荐|请先登录|登录后.*笔记/,
  },
  { type: "captcha", text: /验证码|安全验证|拖动滑块|人机验证/ },
  { type: "rate-limit", text: /频繁|限流|稍后再试|操作过于频繁/ },
  { type: "policy", text: /权限|无权|禁止|违规|风险|审核(?:未通过|不通过|拒绝)/ },
];

function isSystemPage(url) {
  return /^(edge|chrome|about|devtools):/i.test(url || "");
}

function isXiaohongshuPage(url) {
  return /xiaohongshu\.com/i.test(url || "");
}

function cleanText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function loginEvidence(cookies, block) {
  const sessionCookies = (cookies || [])
    .map((cookie) => String(cookie.name || "").toLowerCase())
    .filter((name) => /^(web_session|sessionid|sid_guard|passport_auth_token)$/.test(name));
  if (block?.type === "login") return { loginState: "logged-out", loggedInLikely: false, sessionCookies };
  if (sessionCookies.length) return { loginState: "likely-logged-in", loggedInLikely: true, sessionCookies };
  return { loginState: "unknown", loggedInLikely: false, sessionCookies };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(token);
    }
  }
  return out;
}

function usage() {
  console.log(`Usage:
  xiaohongshu_web.mjs detect-browser
  xiaohongshu_web.mjs accounts list|add|default|remove [NAME] [--alias ALIAS]
  xiaohongshu_web.mjs login [--browser default] [--account default] [--wait-ms 300000]
  xiaohongshu_web.mjs browser-status [--browser default] [--account default]
  xiaohongshu_web.mjs close-browser [--browser default] [--account default]
  xiaohongshu_web.mjs status [--browser default] [--account default]
  xiaohongshu_web.mjs open-url URL [--browser default] [--account default]
  xiaohongshu_web.mjs search QUERY [--browser default] [--account default] [--limit 20] [--out results.json]
  xiaohongshu_web.mjs click-text TEXT [--browser default] [--account default] [--exact]
  xiaohongshu_web.mjs fill SELECTOR TEXT [--browser default] [--account default]
  xiaohongshu_web.mjs message RECIPIENT MESSAGE [--browser default] [--account default] [--direct]
  xiaohongshu_web.mjs publish PACKAGE_JSON [--browser default] [--account default] [--direct]
  xiaohongshu_web.mjs run-plan PLAN_JSON [--browser default] [--account default] [--direct] [--out result.json] [--artifact-dir DIR]

Browsers:
  default, chromium, chrome, chrome-canary, edge, edge-canary, brave, arc, firefox, webkit, safari

Login:
  Run login once, complete Xiaohongshu login in the opened browser, then press Enter.
  Later commands reuse the persistent profile under:
  ${STATE_DIR}

Session reuse:
  Chromium-like browsers are launched once through CDP and reused across commands.
  Use run-plan for multi-step work so search/browse/comment/like/publish operations run
  inside a single browser tab without repeated open/close cycles.
`);
}

function accountFromArgs(args = {}) {
  return ACCOUNT_MANAGER.resolve(args.account || ACCOUNT_MANAGER.defaultAccount());
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function acquireLock(name = "xiaohongshu-web") {
  return acquireProcessLock({ lockDir: LOCK_DIR, name, label: "Xiaohongshu" });
}

function detectDefaultBrowserBundle() {
  const plist = path.join(
    os.homedir(),
    "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist"
  );
  try {
    const raw = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist], {
      encoding: "utf8",
    });
    const data = JSON.parse(raw);
    const handlers = data.LSHandlers || [];
    const found =
      handlers.find((h) => h.LSHandlerURLScheme === "https" && h.LSHandlerRoleAll) ||
      handlers.find((h) => h.LSHandlerURLScheme === "http" && h.LSHandlerRoleAll);
    return found?.LSHandlerRoleAll || "com.apple.Safari";
  } catch (_) {
    return "com.apple.Safari";
  }
}

function browserFromBundle(bundle) {
  const b = (bundle || "").toLowerCase();
  if (b.includes("microsoft.edgemac.canary")) return "edge-canary";
  if (b.includes("google.chrome.canary")) return "chrome-canary";
  if (b.includes("google.chrome")) return "chrome";
  if (b.includes("microsoft.edgemac")) return "edge";
  if (b.includes("firefox")) return "firefox";
  if (b.includes("safari")) return "webkit";
  if (b.includes("brave")) return "brave";
  if (b.includes("arc")) return "arc";
  return "chromium";
}

function normalizeBrowser(name) {
  const selected = (name || "default").toLowerCase();
  if (selected === "default") return browserFromBundle(detectDefaultBrowserBundle());
  if (selected === "safari") return "webkit";
  return selected;
}

function bundleForBrowser(browserName) {
  return {
    chrome: "com.google.Chrome",
    "edge-canary": "com.microsoft.edgemac.canary",
    edge: "com.microsoft.edgemac",
    "chrome-canary": "com.google.Chrome.canary",
    brave: "com.brave.Browser",
    arc: "company.thebrowser.Browser",
  }[browserName];
}

function appPathForBundle(bundle) {
  if (!bundle) return "";
  try {
    return execFileSync("/usr/bin/osascript", ["-e", `POSIX path of (path to application id "${bundle}")`], {
      encoding: "utf8",
    }).trim().replace(/\/$/, "");
  } catch (_) {
    return "";
  }
}

function executableForApp(appPath) {
  if (!appPath) return "";
  try {
    const exe = execFileSync("/usr/bin/plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", path.join(appPath, "Contents/Info.plist")], {
      encoding: "utf8",
    }).trim();
    return path.join(appPath, "Contents/MacOS", exe);
  } catch (_) {
    return "";
  }
}

function userDataDir(browserName, accountName = "default") {
  return ACCOUNT_MANAGER.profileDir(browserName, accountName);
}

function legacyProfileRoots(accountName) {
  if (accountName !== "default") return [];
  const skillsDir = path.join(os.homedir(), ".codex", "skills");
  return [
    path.join(skillsDir, "rednote-local", "state", "web", "profiles"),
    path.join(skillsDir, "do-anything-in-rednotes", "state", "web", "profiles"),
  ];
}

function cdpSessionPath(browserName) {
  return path.join(STATE_DIR, "cdp-sessions", `${browserName}.json`);
}

function readCdpSession(browserName) {
  try {
    return JSON.parse(fs.readFileSync(cdpSessionPath(browserName), "utf8"));
  } catch (_) {
    return null;
  }
}

function writeCdpSession(browserName, payload) {
  ensureDir(path.dirname(cdpSessionPath(browserName)));
  fs.writeFileSync(cdpSessionPath(browserName), JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function clearCdpSession(browserName) {
  fs.rmSync(cdpSessionPath(browserName), { force: true });
}

function isCdpBrowser(browserName) {
  return Object.prototype.hasOwnProperty.call(CDP_PORTS, browserName);
}

function isPortOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(700);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const done = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once("timeout", done);
    socket.once("error", done);
  });
}

async function waitForPort(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return false;
}

function executableForBrowser(browserName) {
  const customBundle = bundleForBrowser(browserName);
  const customExecutable = executableForApp(appPathForBundle(customBundle));
  if (customExecutable && fs.existsSync(customExecutable)) return customExecutable;
  if (browserName === "chromium") return chromium.executablePath();
  return "";
}

async function ensureCdpBrowser(browserName, accountName) {
  const port = CDP_PORTS[browserName];
  if (await isPortOpen(port)) {
    await validateCdpOwnership({
      port,
      browserName,
      accountName,
      profile: userDataDir(browserName, accountName),
      profileRoot: path.join(STATE_DIR, "profiles"),
      legacyProfileRoots: legacyProfileRoots(accountName),
      readSession: () => readCdpSession(browserName),
      writeSession: (session) => writeCdpSession(browserName, session),
    });
    return { port, launched: false };
  }

  const executable = executableForBrowser(browserName);
  if (!executable || !fs.existsSync(executable)) {
    throw new Error(`No executable found for ${browserName}`);
  }
  ensureDir(userDataDir(browserName, accountName));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir(browserName, accountName)}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-background-media-suspend",
    "https://www.xiaohongshu.com/explore",
  ];
  const proc = spawn(executable, args, {
    detached: true,
    stdio: "ignore",
  });
  proc.unref();
  const ok = await waitForPort(port);
  if (!ok) throw new Error(`Timed out waiting for ${browserName} CDP port ${port}`);
  writeCdpSession(browserName, {
    browser: browserName,
    account: accountName,
    profile: userDataDir(browserName, accountName),
    port,
    startedAt: new Date().toISOString(),
  });
  return { port, launched: true };
}

async function launch(browserArg, accountArg) {
  const browserName = normalizeBrowser(browserArg);
  const accountName = ACCOUNT_MANAGER.resolve(accountArg || ACCOUNT_MANAGER.defaultAccount());
  ensureDir(userDataDir(browserName, accountName));
  if (isCdpBrowser(browserName)) {
    const { port } = await ensureCdpBrowser(browserName, accountName);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0] || (await browser.newContext());
    return {
      browserName,
      accountName,
      context,
      cdp: true,
      cdpPort: port,
      cleanup: async () => browser.disconnect(),
      closeBrowser: async () => browser.close(),
    };
  }

  const common = {
    headless: false,
    viewport: { width: 1320, height: 900 },
    acceptDownloads: true,
  };

  if (browserName === "firefox") {
    const context = await firefox.launchPersistentContext(userDataDir(browserName, accountName), common);
    return { browserName, accountName, context, cdp: false, cleanup: async () => context.close() };
  }
  if (browserName === "webkit") {
    const context = await webkit.launchPersistentContext(userDataDir(browserName, accountName), common);
    return { browserName, accountName, context, cdp: false, cleanup: async () => context.close() };
  }

  const customBundle = bundleForBrowser(browserName);
  const customExecutable = executableForApp(appPathForBundle(customBundle));
  if (customExecutable && fs.existsSync(customExecutable)) {
    const context = await chromium.launchPersistentContext(userDataDir(browserName, accountName), {
      ...common,
      executablePath: customExecutable,
    });
    return {
      browserName,
      accountName,
      context,
      cdp: false,
      cleanup: async () => context.close(),
    };
  }

  const channel = browserName === "chrome" ? "chrome" : browserName === "edge" ? "msedge" : undefined;
  try {
    const context = await chromium.launchPersistentContext(userDataDir(browserName, accountName), { ...common, channel });
    return {
      browserName,
      accountName,
      context,
      cdp: false,
      cleanup: async () => context.close(),
    };
  } catch (err) {
    if (channel) {
      console.error(`Channel ${channel} failed, falling back to bundled Chromium: ${err.message}`);
    } else {
      throw err;
    }
    const context = await chromium.launchPersistentContext(userDataDir("chromium", accountName), common);
    return {
      browserName: "chromium",
      accountName,
      context,
      cdp: false,
      cleanup: async () => context.close(),
    };
  }
}

async function pageFor(context) {
  const pages = context.pages();
  const page =
    [...pages].reverse().find((candidate) => isXiaohongshuPage(candidate.url()) && !isSystemPage(candidate.url())) ||
    [...pages].reverse().find((candidate) => !isSystemPage(candidate.url())) ||
    pages[0] ||
    (await context.newPage());
  page.setDefaultTimeout(15000);
  return page;
}

async function waitForEnterOrTimeout(ms) {
  if (!process.stdin.isTTY) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await Promise.race([
    new Promise((resolve) => rl.question("Press Enter after login is complete...", resolve)),
    new Promise((resolve) => setTimeout(resolve, ms)),
  ]);
  rl.close();
}

async function goto(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(1500);
}

async function safeCleanup(session) {
  if (session?.cleanup) await session.cleanup().catch(() => {});
}

async function pageSnapshot(page, limit = 50) {
  return await sdkPageSnapshot(page, limit);
}

async function detectBlock(page) {
  return await sdkDetectBlock(page, BLOCK_RULES);
}

async function assertNotBlocked(page, label = "operation") {
  return await sdkAssertNotBlocked(page, BLOCK_RULES, `Xiaohongshu ${label}`);
}

async function scrollAllContainers(page) {
  return await sdkScrollAllContainers(page);
}

async function publishViaCreatorButton(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await scrollAllContainers(page).catch(() => []);
  await page.waitForTimeout(500);

  const result = await page.evaluate(() => {
    const visible = (el) => el instanceof HTMLElement && (el.offsetParent !== null || el.getClientRects().length > 0);
    const custom = [...document.querySelectorAll("xhs-publish-btn")].filter(visible).at(-1);
    if (custom) {
      const disabled =
        custom.getAttribute("submit-disabled") === "true" ||
        custom.getAttribute("disabled") === "true" ||
        custom.getAttribute("aria-disabled") === "true";
      if (disabled) {
        return {
          ok: false,
          method: "xhs-publish-btn",
          reason: "disabled",
          attrs: Object.fromEntries([...custom.attributes].map((attr) => [attr.name, attr.value])),
        };
      }
      if (typeof custom._onPublish === "function") {
        const value = custom._onPublish();
        return { ok: true, method: "xhs-publish-btn._onPublish", resultType: typeof value };
      }
      custom.click();
      return { ok: true, method: "xhs-publish-btn.click" };
    }

    const candidates = [...document.querySelectorAll("button,[role='button'],.publishBtn,.submit,.submit-btn")]
      .filter(visible)
      .filter((el) => /(^|\s)发布($|\s)|发布笔记/.test((el.innerText || el.textContent || "").replace(/\s+/g, " ").trim()));
    const button = candidates.at(-1);
    if (!button) {
      return {
        ok: false,
        method: "none",
        reason: "no publish control",
        controls: [...document.querySelectorAll("button,[role='button'],xhs-publish-btn")]
          .filter(visible)
          .slice(-20)
          .map((el) => ({
            tag: el.tagName,
            text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100),
            attrs: Object.fromEntries(
              [...el.attributes]
                .filter((attr) => /^(submit|aria|role|class|type|disabled)/i.test(attr.name))
                .slice(0, 12)
                .map((attr) => [attr.name, attr.value])
            ),
          })),
      };
    }
    button.click();
    return { ok: true, method: "button.click" };
  });

  if (!result.ok) throw new Error(`Publish control unavailable: ${JSON.stringify(result)}`);
  return result;
}

async function clickAnyText(page, texts, waitMs = 700) {
  return await sdkClickAnyText(page, texts, waitMs);
}

async function clickByText(page, text, exact = false) {
  if (exact) {
    const candidates = page.getByText(text, { exact: true });
    const count = await candidates.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index--) {
      const candidate = candidates.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      await candidate.click();
      return { clicked: true, text, exact: true, index };
    }
    throw new Error(`No clickable visible exact text found: ${text}`);
  }
  const result = await clickAnyText(page, [text], 0);
  if (!result.clicked) throw new Error(`No clickable visible text found: ${text}`);
  return result;
}

async function clickFirstVisibleSelector(page, selector, label = selector) {
  const candidates = page.locator(selector);
  const count = await candidates.count().catch(() => 0);
  for (let index = 0; index < count; index++) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    await candidate.click();
    return { selector, index };
  }
  throw new Error(`No visible ${label} found for selector: ${selector}`);
}

async function cmdLogin(args) {
  const session = await launch(args.browser, args.account);
  const { browserName, accountName, context } = session;
  const page = await pageFor(context);
  await goto(page, "https://www.xiaohongshu.com/explore");
  console.log(`Opened Xiaohongshu in ${browserName} for account '${accountName}'. Complete login in the browser window.`);
  await waitForEnterOrTimeout(Number(args["wait-ms"] || 300000));
  await context.storageState({ path: path.join(STATE_DIR, `${browserName}-${accountName}-storage.json`) }).catch(() => {});
  await safeCleanup(session);
  console.log(`Saved persistent profile: ${userDataDir(browserName, accountName)}`);
}

async function cmdStatus(args) {
  const session = await launch(args.browser, args.account);
  const { browserName, accountName, context, cdp, cdpPort } = session;
  const page = await pageFor(context);
  await goto(page, "https://www.xiaohongshu.com/explore");
  const cookies = await context.cookies("https://www.xiaohongshu.com");
  const block = await detectBlock(page);
  const login = loginEvidence(cookies, block);
  const status = {
    browser: browserName,
    account: accountName,
    session: cdp ? "cdp-reused-browser" : "single-command-browser",
    cdpPort: cdpPort || null,
    activeProfile: cdp ? readCdpSession(browserName)?.profile || userDataDir(browserName, accountName) : userDataDir(browserName, accountName),
    url: page.url(),
    title: await page.title().catch(() => ""),
    cookieCount: cookies.length,
    ...login,
    block,
    profile: userDataDir(browserName, accountName),
  };
  console.log(JSON.stringify(status, null, 2));
  await safeCleanup(session);
}

async function cmdBrowserStatus(args) {
  const browserName = normalizeBrowser(args.browser);
  const accountName = accountFromArgs(args);
  const port = CDP_PORTS[browserName] || null;
  const endpoint = port ? await probeCdpEndpoint(port) : null;
  const activeCdpSession = readCdpSession(browserName);
  const status = {
    browser: browserName,
    account: accountName,
    cdpSupported: Boolean(port),
    cdpPort: port,
    running: Boolean(endpoint?.reachable),
    cdpEndpoint: endpoint,
    activeCdpSession,
    sessionState: !port ? "not-applicable" : activeCdpSession?.legacyProfile ? "legacy-adopted" : activeCdpSession ? "managed" : endpoint?.reachable ? "unmanaged-or-recoverable" : "stopped",
    profile: userDataDir(browserName, accountName),
  };
  console.log(JSON.stringify(status, null, 2));
}

async function cmdCloseBrowser(args) {
  const browserName = normalizeBrowser(args.browser);
  if (!isCdpBrowser(browserName) || !(await isPortOpen(CDP_PORTS[browserName]))) {
    console.log(JSON.stringify({ browser: browserName, closed: false, note: "no reusable CDP browser running" }, null, 2));
    return;
  }
  const accountName = accountFromArgs(args);
  await validateCdpOwnership({
    port: CDP_PORTS[browserName],
    browserName,
    accountName,
    profile: userDataDir(browserName, accountName),
    profileRoot: path.join(STATE_DIR, "profiles"),
    legacyProfileRoots: legacyProfileRoots(accountName),
    readSession: () => readCdpSession(browserName),
    writeSession: (session) => writeCdpSession(browserName, session),
    allowDifferentAccount: true,
  });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORTS[browserName]}`);
  await browser.close();
  clearCdpSession(browserName);
  console.log(JSON.stringify({ browser: browserName, closed: true, cdpPort: CDP_PORTS[browserName] }, null, 2));
}

async function cmdOpenUrl(args) {
  const url = args._[1];
  if (!url) throw new Error("open-url requires URL");
  const session = await launch(args.browser, args.account);
  const { context } = session;
  const page = await pageFor(context);
  await goto(page, url);
  console.log(page.url());
  await safeCleanup(session);
}

async function collectVisibleNotes(page, limit) {
  return (await collectXiaohongshuFeedItems(page, { limit })).items;
}

async function cmdSearch(args) {
  const query = args._[1];
  if (!query) throw new Error("search requires QUERY");
  const limit = Number(args.limit || 20);
  const session = await launch(args.browser, args.account);
  const { browserName, accountName, context } = session;
  const page = await pageFor(context);
  const url = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(query)}`;
  await goto(page, url);
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(800);
  }
  const payload = await collectXiaohongshuFeedItems(page, { limit });
  const result = {
    browser: browserName,
    account: accountName,
    query,
    url: page.url(),
    count: payload.items.length,
    sourceSummary: payload.sourceSummary,
    stateKeys: payload.stateKeys,
    items: payload.items,
  };
  const text = JSON.stringify(result, null, 2);
  if (args.out) fs.writeFileSync(path.resolve(args.out), text + "\n", "utf8");
  console.log(text);
  await safeCleanup(session);
}

async function cmdClickText(args) {
  const text = args._[1];
  if (!text) throw new Error("click-text requires TEXT");
  const session = await launch(args.browser, args.account);
  const { context } = session;
  const page = await pageFor(context);
  await clickByText(page, text, Boolean(args.exact));
  console.log(`clicked: ${text}`);
  await safeCleanup(session);
}

async function cmdFill(args) {
  const selector = args._[1];
  const text = args._[2];
  if (!selector || text === undefined) throw new Error("fill requires SELECTOR TEXT");
  const session = await launch(args.browser, args.account);
  const { context } = session;
  const page = await pageFor(context);
  await fillFirstVisible(page, [selector], text, selector);
  console.log(`filled: ${selector}`);
  await safeCleanup(session);
}

async function fillFirstEditable(page, text) {
  return await sdkFillFirstEditable(page, text);
}

async function fillFirstVisible(page, selectors, text, label) {
  return await sdkFillFirstVisible(page, selectors, text, label);
}

async function clickSemanticControl(page, kind) {
  return await sdkClickSemanticControl(page, kind, {
    like: /(点赞|赞|like)/i,
    favorite: /(收藏|collect|favorite|save)/i,
    collect: /(收藏|collect|favorite|save)/i,
    comment: /(评论|comment)/i,
    share: /(分享|转发|share)/i,
    follow: /(关注|follow)/i,
  });
}

const COMMENT_SELECTORS = [
  'textarea[placeholder*="评论"]',
  'textarea[placeholder*="说点什么"]',
  'input[placeholder*="评论"]',
  '[contenteditable="true"][data-placeholder*="评论"]',
  '[contenteditable="true"][data-placeholder*="说点什么"]',
  '[role="textbox"]',
  '[contenteditable="true"]',
  "textarea",
];

const MESSAGE_SELECTORS = [
  'textarea[placeholder*="消息"]',
  'textarea[placeholder*="说点什么"]',
  'input[placeholder*="消息"]',
  '[contenteditable="true"][data-placeholder*="消息"]',
  '[contenteditable="true"][data-placeholder*="说点什么"]',
  '[role="textbox"]',
  '[contenteditable="true"]',
  "textarea",
];

async function fillCommentBox(page, text) {
  await clickSemanticControl(page, "comment").catch(() => null);
  const selector = await fillFirstVisible(page, COMMENT_SELECTORS, text, "comment");
  return { selector, selectors: COMMENT_SELECTORS };
}

async function fillMessageBox(page, text) {
  const selector = await fillFirstVisible(page, MESSAGE_SELECTORS, text, "message");
  return { selector, selectors: MESSAGE_SELECTORS };
}

async function cmdMessage(args) {
  const recipient = args._[1];
  const message = args._[2];
  if (!recipient || message === undefined) throw new Error("message requires RECIPIENT MESSAGE");
  if (!String(message).trim()) throw new Error("message content must not be empty");
  const session = await launch(args.browser, args.account);
  try {
    const page = await pageFor(session.context);
    await goto(page, "https://www.xiaohongshu.com/notification");
    await clickByText(page, recipient);
    const field = await fillMessageBox(page, message);
    let verification = { status: "staged" };
    if (args.direct) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1000);
      verification = await sdkVerifyTextSubmission(page, field.selectors, message);
    }
    const result = { recipient, direct: Boolean(args.direct), verification, url: page.url() };
    console.log(JSON.stringify(result, null, 2));
    if (args.direct && verification.status !== "confirmed") {
      throw new Error(`Message delivery is ${verification.status}: ${verification.reason || "no delivery evidence"}`);
    }
  } finally {
    await safeCleanup(session);
  }
}

async function cmdPublish(args) {
  const packagePath = args._[1];
  if (!packagePath) throw new Error("publish requires PACKAGE_JSON");
  validatePostPackage(JSON.parse(fs.readFileSync(path.resolve(packagePath), "utf8")), packagePath);
  const session = await launch(args.browser, args.account);
  try {
    const page = await pageFor(session.context);
    const result = await publishPackage(page, packagePath, args);
    console.log(JSON.stringify(result, null, 2));
    assertDirectPublishConfirmed(result);
  } finally {
    await safeCleanup(session);
  }
}

function validatePostPackage(data, packagePath) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Post package must be a JSON object");
  }
  const title = cleanText(data.title);
  if (!title) throw new Error("Xiaohongshu post package requires a non-empty title");
  const titleLength = Array.from(title).length;
  if (titleLength > 20) throw new Error(`Xiaohongshu title is too long (${titleLength}/20): ${title}`);
  const requestedImages = Array.isArray(data.images) ? data.images.map((value) => path.resolve(String(value))) : [];
  if (!requestedImages.length) throw new Error("Xiaohongshu image-note package requires at least one image");
  const invalidImages = requestedImages.filter((file) => !fs.statSync(file, { throwIfNoEntry: false })?.isFile());
  if (invalidImages.length) throw new Error(`Post package references missing or invalid image files: ${invalidImages.join(", ")}`);
  return { title, files: requestedImages, package: path.resolve(packagePath) };
}

async function verifyPublishOutcome(page, args = {}) {
  const timeoutMs = Number(args["publish-timeout-ms"] || args.publishTimeoutMs || 12000);
  const pollMs = Number(args["publish-poll-ms"] || args.publishPollMs || 750);
  const startedAt = Date.now();
  let lastSnapshot = { body: "" };
  while (Date.now() - startedAt <= timeoutMs) {
    lastSnapshot = await pageSnapshot(page, 30);
    const body = lastSnapshot.body || "";
    const success = /[?&]published=true\b/.test(page.url()) || /发布成功|已发布|审核中|提交成功/.test(body);
    if (success) {
      return {
        status: "published",
        likelyPublished: true,
        url: page.url(),
        waitedMs: Date.now() - startedAt,
        bodyExcerpt: body.slice(0, 600),
      };
    }
    const block = await detectBlock(page);
    if (block) {
      return {
        status: "blocked",
        likelyPublished: false,
        url: page.url(),
        waitedMs: Date.now() - startedAt,
        block,
        bodyExcerpt: body.slice(0, 600),
      };
    }
    await page.waitForTimeout(pollMs);
  }
  return {
    status: "unconfirmed",
    likelyPublished: false,
    url: page.url(),
    waitedMs: Date.now() - startedAt,
    bodyExcerpt: (lastSnapshot.body || "").slice(0, 600),
  };
}

function publishOperationVerification(result) {
  if (!result.direct) return { status: "staged" };
  const verification = result.publishVerification;
  if (verification?.status === "published") {
    return { status: "confirmed", evidence: "creator page reported published", publishVerification: verification };
  }
  if (verification?.status === "blocked") {
    return { status: "blocked", reason: "creator page reported a block", block: verification.block, publishVerification: verification };
  }
  return { status: "unconfirmed", reason: "creator page did not confirm publication", publishVerification: verification || null };
}

function assertDirectPublishConfirmed(result) {
  const verification = publishOperationVerification(result);
  if (result.direct && verification.status !== "confirmed") {
    throw new Error(`Publish is ${verification.status}: ${verification.reason || "creator page did not confirm publication"}`);
  }
}

async function publishPackage(page, packagePath, args = {}) {
  const data = JSON.parse(fs.readFileSync(path.resolve(packagePath), "utf8"));
  const packageInfo = validatePostPackage(data, packagePath);
  const bodyText = [
    data.body || data.title || "",
    "",
    ...(Array.isArray(data.hashtags) ? data.hashtags : []).map((t) => `#${String(t).replace(/^#/, "")}`),
  ]
    .join("\n")
    .trim();
  await goto(page, args.url || "https://creator.xiaohongshu.com/publish/publish");
  await assertNotBlocked(page, "open creator publish page");
  const modeSelection = await clickAnyText(page, ["上传图文", "发布图文"], 1200);
  if (!modeSelection.clicked && !(await page.locator("input[type='file']").count().catch(() => 0))) {
    throw new Error("Xiaohongshu image upload mode is unavailable");
  }
  await page.waitForTimeout(1200);
  await assertNotBlocked(page, "select image publishing");

  const files = packageInfo.files;
  const fileInput = page.locator("input[type='file']");
  const fileInputCount = await fileInput.count().catch(() => 0);
  if (!fileInputCount) throw new Error("No upload file input found");
  await fileInput.nth(fileInputCount - 1).setInputFiles(files);
  await page.waitForTimeout(Number(args["upload-wait-ms"] || args.uploadWaitMs || 5000));

  await fillFirstVisible(
    page,
    [
      'input[placeholder*="填写标题"]',
      'input[placeholder*="标题"]',
      ".d-input input",
      "input[type='text']",
    ],
    packageInfo.title,
    "title"
  );
  await fillFirstVisible(
    page,
    [
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"][data-placeholder*="正文"]',
      'div[contenteditable="true"]',
      "textarea",
      "[role='textbox']",
    ],
    bodyText,
    "content"
  );

  let publishAttempt = null;
  let publishVerification = null;
  if (args.direct) {
    publishAttempt = await publishViaCreatorButton(page);
    publishVerification = await verifyPublishOutcome(page, args);
  }
  return {
    package: packageInfo.package,
    direct: Boolean(args.direct),
    url: page.url(),
    files,
    title: packageInfo.title,
    modeSelection,
    publishAttempt,
    publishVerification,
  };
}

function readPlan(planPath) {
  if (!planPath) throw new Error("run-plan requires PLAN_JSON");
  const raw = fs.readFileSync(path.resolve(planPath), "utf8");
  const plan = JSON.parse(raw);
  if (!Array.isArray(plan.operations)) throw new Error("PLAN_JSON must contain an operations array");
  return plan;
}

async function runOperation(page, op, args, index) {
  const action = op.action || op.type;
  if (!action) throw new Error(`operation ${index} is missing action`);
  const direct = op.direct ?? args.direct ?? false;

  if (action === "goto" || action === "open-url" || action === "open_url") {
    if (!op.url) throw new Error(`operation ${index} requires url`);
    await goto(page, op.url);
    return { action, url: page.url() };
  }
  if (action === "search") {
    if (!op.query) throw new Error(`operation ${index} requires query`);
    await goto(page, `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(op.query)}`);
    const scrolls = Number(op.scrolls ?? 3);
    for (let i = 0; i < scrolls; i++) {
      await page.mouse.wheel(0, Number(op.scrollY ?? 900));
      await page.waitForTimeout(Number(op.waitMs ?? 700));
    }
    const payload = await collectXiaohongshuFeedItems(page, { limit: Number(op.limit || 20) });
    return {
      action,
      query: op.query,
      url: page.url(),
      count: payload.items.length,
      sourceSummary: payload.sourceSummary,
      stateKeys: payload.stateKeys,
      items: payload.items,
    };
  }
  if (action === "click-text" || action === "click_text") {
    if (!op.text) throw new Error(`operation ${index} requires text`);
    await clickByText(page, op.text, Boolean(op.exact));
    await page.waitForTimeout(Number(op.waitMs ?? 800));
    return { action, text: op.text, url: page.url() };
  }
  if (action === "click") {
    if (!op.selector) throw new Error(`operation ${index} requires selector`);
    const clicked = await clickFirstVisibleSelector(page, op.selector, "click target");
    await page.waitForTimeout(Number(op.waitMs ?? 800));
    return { action, ...clicked, url: page.url() };
  }
  if (action === "fill") {
    if (!op.selector || op.text === undefined) throw new Error(`operation ${index} requires selector and text`);
    await fillFirstVisible(page, [op.selector], String(op.text), op.selector);
    return { action, selector: op.selector };
  }
  if (action === "fill-first" || action === "fill_first") {
    if (op.text === undefined) throw new Error(`operation ${index} requires text`);
    const selector = await fillFirstEditable(page, String(op.text));
    return { action, selector };
  }
  if (action === "press") {
    if (!op.key) throw new Error(`operation ${index} requires key`);
    await page.keyboard.press(op.key);
    await page.waitForTimeout(Number(op.waitMs ?? 400));
    return { action, key: op.key, url: page.url() };
  }
  if (action === "comment") {
    if (op.text === undefined) throw new Error(`operation ${index} requires text`);
    if (!String(op.text).trim()) throw new Error(`operation ${index} comment text must not be empty`);
    const field = await fillCommentBox(page, String(op.text));
    let verification = { status: "staged" };
    if (direct) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(Number(op.waitMs ?? 1000));
      verification = await sdkVerifyTextSubmission(page, field.selectors, String(op.text));
    }
    return { action, selector: field.selector, direct: Boolean(direct), verification, url: page.url() };
  }
  if (action === "like" || action === "favorite" || action === "collect" || action === "share" || action === "follow") {
    const waitMs = Number(op.waitMs ?? 800);
    const result = op.text
      ? await clickAnyText(page, [op.text], waitMs)
      : await clickSemanticControl(page, action);
    if (!result.clicked) throw new Error(`No clickable ${action} control found`);
    const verification = op.text
      ? { status: "unconfirmed", reason: "text-targeted interaction has no platform state verifier" }
      : await sdkVerifySemanticClick(page, result, waitMs);
    return { action, result, verification, url: page.url() };
  }
  if (action === "scroll") {
    const times = Number(op.times || 1);
    for (let i = 0; i < times; i++) {
      await page.mouse.wheel(Number(op.x || 0), Number(op.y ?? op.scrollY ?? 900));
      await page.waitForTimeout(Number(op.waitMs ?? 500));
    }
    return { action, times, url: page.url() };
  }
  if (action === "wait") {
    await page.waitForTimeout(Number(op.ms || op.waitMs || 1000));
    return { action, waitedMs: Number(op.ms || op.waitMs || 1000) };
  }
  if (action === "extract" || action === "snapshot") {
    return { action, snapshot: await pageSnapshot(page, Number(op.limit || 80)) };
  }
  if (action === "diagnose") {
    const snapshot = await pageSnapshot(page, Number(op.limit || 120));
    const block = await detectBlock(page);
    return { action, block, snapshot };
  }
  if (action === "scroll-containers" || action === "scroll_containers") {
    const scrolled = await scrollAllContainers(page);
    await page.waitForTimeout(Number(op.waitMs ?? 500));
    return { action, scrolled, url: page.url() };
  }
  if (action === "notification" || action === "notifications") {
    await goto(page, op.url || "https://www.xiaohongshu.com/notification");
    await page.waitForTimeout(Number(op.waitMs ?? 2000));
    return { action, snapshot: await pageSnapshot(page, Number(op.limit || 80)) };
  }
  if (action === "publish-package" || action === "publish_package") {
    if (!op.package) throw new Error(`operation ${index} requires package`);
    const result = await publishPackage(page, op.package, { ...args, ...op, direct });
    return { action, result, verification: publishOperationVerification(result) };
  }
  if (action === "evaluate") {
    if (!op.js) throw new Error(`operation ${index} requires js`);
    const source = String(op.js).trim();
    const value = await page.evaluate((source) => {
      if (/^(async\s+)?function\b|^\(?\s*(async\s*)?[\w\s,{}[\]().=]*\)?\s*=>/.test(source)) {
        const fn = (0, eval)(`(${source})`);
        return typeof fn === "function" ? fn() : fn;
      }
      return (0, eval)(source);
    }, source);
    return { action, value };
  }
  throw new Error(`Unsupported operation action: ${action}`);
}

async function cmdRunPlan(args) {
  const sdkPlanPath = args._[1];
  const sdkPlan = readPlan(sdkPlanPath);
  const sdkResult = await sdkRunPlan({
    planPath: sdkPlanPath,
    plan: sdkPlan,
    args,
    stateDir: STATE_DIR,
    platform: "xiaohongshu",
    launch,
    pageFor,
    detectBlock,
    runOperation,
    safeCleanup,
  });
  console.log(JSON.stringify(sdkResult, null, 2));
}

async function cmdAccounts(args) {
  const sub = args._[1] || "list";
  if (sub === "list") {
    console.log(JSON.stringify(ACCOUNT_MANAGER.list(), null, 2));
    return;
  }
  if (sub === "add") {
    const name = args._[2];
    if (!name) throw new Error("accounts add requires NAME");
    console.log(JSON.stringify(ACCOUNT_MANAGER.add(name, args.alias || ""), null, 2));
    return;
  }
  if (sub === "default") {
    const name = args._[2];
    if (!name) throw new Error("accounts default requires NAME");
    console.log(JSON.stringify({ defaultAccount: ACCOUNT_MANAGER.setDefault(name) }, null, 2));
    return;
  }
  if (sub === "remove") {
    const name = args._[2];
    if (!name) throw new Error("accounts remove requires NAME");
    console.log(JSON.stringify(ACCOUNT_MANAGER.remove(name), null, 2));
    return;
  }
  throw new Error(`Unknown accounts subcommand: ${sub}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help || args.h) {
    usage();
    return;
  }
  const releaseLock = MUTATING_COMMANDS.has(cmd) ? acquireLock() : null;
  try {
    if (cmd === "detect-browser") {
      const bundle = detectDefaultBrowserBundle();
      console.log(JSON.stringify({ bundle, browser: normalizeBrowser("default") }, null, 2));
    } else if (cmd === "accounts") await cmdAccounts(args);
    else if (cmd === "browser-status") await cmdBrowserStatus(args);
    else if (cmd === "close-browser") await cmdCloseBrowser(args);
    else if (cmd === "login") await cmdLogin(args);
    else if (cmd === "status") await cmdStatus(args);
    else if (cmd === "open-url") await cmdOpenUrl(args);
    else if (cmd === "search") await cmdSearch(args);
    else if (cmd === "click-text") await cmdClickText(args);
    else if (cmd === "fill") await cmdFill(args);
    else if (cmd === "message") await cmdMessage(args);
    else if (cmd === "publish") await cmdPublish(args);
    else if (cmd === "run-plan") await cmdRunPlan(args);
    else throw new Error(`Unknown command: ${cmd}`);
  } finally {
    if (releaseLock) releaseLock();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`xiaohongshu_web.mjs: ${err.message}${err.artifactDir ? `\nartifacts: ${err.artifactDir}` : ""}`);
    process.exit(2);
  });
