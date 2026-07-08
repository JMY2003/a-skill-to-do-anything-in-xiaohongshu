import fs from "node:fs";
import path from "node:path";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export class AccountManager {
  constructor({ stateDir, platform }) {
    this.stateDir = stateDir;
    this.platform = platform;
    this.configPath = path.join(stateDir, "accounts.json");
  }

  load() {
    const data = readJson(this.configPath, null);
    if (data && data.accounts && data.defaultAccount) return data;
    return {
      platform: this.platform,
      defaultAccount: "default",
      accounts: {
        default: {
          name: "default",
          alias: "Default",
          createdAt: null,
          legacyProfileLayout: true,
        },
      },
    };
  }

  save(data) {
    writeJson(this.configPath, data);
  }

  validateName(name) {
    const value = String(name || "").trim() || "default";
    if (!NAME_RE.test(value)) {
      throw new Error(`Invalid account name: ${value}. Use letters, numbers, dot, dash, or underscore.`);
    }
    return value;
  }

  defaultAccount() {
    return this.load().defaultAccount || "default";
  }

  resolve(name) {
    const data = this.load();
    const accountName = this.validateName(name || data.defaultAccount || "default");
    if (!data.accounts[accountName]) {
      data.accounts[accountName] = {
        name: accountName,
        alias: accountName,
        createdAt: new Date().toISOString(),
      };
      this.save(data);
    }
    return accountName;
  }

  profileDir(browserName, accountName = "default") {
    const name = this.resolve(accountName);
    if (name === "default") return path.join(this.stateDir, "profiles", browserName);
    return path.join(this.stateDir, "accounts", name, "profiles", browserName);
  }

  list() {
    const data = this.load();
    return {
      platform: this.platform,
      defaultAccount: data.defaultAccount || "default",
      accounts: Object.values(data.accounts || {}).map((item) => ({
        name: item.name,
        alias: item.alias || item.name,
        createdAt: item.createdAt || null,
        legacyProfileLayout: Boolean(item.legacyProfileLayout),
      })),
    };
  }

  add(name, alias = "") {
    const accountName = this.validateName(name);
    const data = this.load();
    if (!data.accounts[accountName]) {
      data.accounts[accountName] = {
        name: accountName,
        alias: alias || accountName,
        createdAt: new Date().toISOString(),
      };
    } else if (alias) {
      data.accounts[accountName].alias = alias;
    }
    this.save(data);
    return data.accounts[accountName];
  }

  setDefault(name) {
    const accountName = this.resolve(name);
    const data = this.load();
    data.defaultAccount = accountName;
    this.save(data);
    return accountName;
  }

  remove(name) {
    const accountName = this.validateName(name);
    if (accountName === "default") throw new Error("The default account record cannot be removed.");
    const data = this.load();
    const existed = Boolean(data.accounts[accountName]);
    delete data.accounts[accountName];
    if (data.defaultAccount === accountName) data.defaultAccount = "default";
    this.save(data);
    return { removed: existed, account: accountName };
  }
}
