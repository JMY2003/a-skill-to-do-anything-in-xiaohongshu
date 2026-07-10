import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}

export function acquireProcessLock({ lockDir, name, label }) {
  ensureDir(lockDir);
  const lockPath = path.join(lockDir, `${name}.lock`);
  const payload = {
    pid: process.pid,
    token: randomUUID(),
    startedAt: new Date().toISOString(),
    argv: process.argv,
    cwd: process.cwd(),
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
      } catch (err) {
        fs.rmSync(lockPath, { force: true });
        throw err;
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        const existing = readJson(lockPath);
        if (existing?.pid === process.pid && existing?.token === payload.token) {
          fs.rmSync(lockPath, { force: true });
        }
      };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      const existing = readJson(lockPath);
      if (processIsAlive(existing?.pid)) {
        throw new Error(`Another ${label} automation command is running (pid=${existing.pid}, startedAt=${existing.startedAt || "unknown"})`);
      }
      // A corrupt or orphaned lock must not permanently disable the automation runtime.
      fs.rmSync(lockPath, { force: true });
    }
  }
  throw new Error(`Unable to acquire ${label} automation lock after recovering stale lock files`);
}

export async function probeCdpEndpoint(port, timeoutMs = 1500) {
  const url = `http://127.0.0.1:${port}/json/version`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const data = await response.json();
    const webSocketDebuggerUrl = String(data?.webSocketDebuggerUrl || "");
    return {
      reachable: response.ok,
      isCdp: response.ok && webSocketDebuggerUrl.startsWith("ws://"),
      browser: String(data?.Browser || ""),
      protocolVersion: String(data?.["Protocol-Version"] || ""),
      webSocketDebuggerUrl,
    };
  } catch (err) {
    return {
      reachable: false,
      isCdp: false,
      browser: "",
      protocolVersion: "",
      webSocketDebuggerUrl: "",
      error: err?.message || String(err),
    };
  }
}

function commandListeningOnPort(port) {
  try {
    const output = execFileSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
    const pid = Number(output.trim().split(/\s+/)[0]);
    if (!Number.isInteger(pid) || pid <= 0) return { pid: null, command: "" };
    const command = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
    return { pid, command };
  } catch (_) {
    return { pid: null, command: "" };
  }
}

function isManagedProfile(profile, profileRoot) {
  if (!profile || !profileRoot) return false;
  const resolvedProfile = path.resolve(profile);
  const resolvedRoot = path.resolve(profileRoot);
  return resolvedProfile === resolvedRoot || resolvedProfile.startsWith(`${resolvedRoot}${path.sep}`);
}

function commandUsesProfile(command, profile) {
  const resolvedProfile = path.resolve(profile);
  return command.includes(`--user-data-dir=${resolvedProfile}`) || command.includes(`--user-data-dir ${resolvedProfile}`);
}

function profileFromCommand(command, profileRoots) {
  const match = command.match(/--user-data-dir(?:=|\s+)("[^"]+"|\S+)/);
  if (!match) return "";
  const profile = match[1].replace(/^"|"$/g, "");
  return profileRoots.some((root) => isManagedProfile(profile, root)) ? path.resolve(profile) : "";
}

export async function validateCdpOwnership({
  port,
  browserName,
  accountName,
  profile,
  profileRoot,
  readSession,
  writeSession,
  allowDifferentAccount = false,
  legacyProfileRoots = [],
}) {
  const endpoint = await probeCdpEndpoint(port);
  if (!endpoint.reachable || !endpoint.isCdp) {
    throw new Error(`Port ${port} is occupied but is not a Chromium CDP endpoint`);
  }

  const active = readSession();
  const managedRoots = [profileRoot, ...legacyProfileRoots];
  const activeIsManaged = managedRoots.some((root) => isManagedProfile(active?.profile, root));
  const accountMatches = (active?.account || "default") === accountName;
  if (activeIsManaged && (allowDifferentAccount || accountMatches)) {
    return { endpoint, activeSession: active, recovered: false };
  }

  const listener = commandListeningOnPort(port);
  const commandProfile = commandUsesProfile(listener.command, profile)
    ? path.resolve(profile)
    : profileFromCommand(listener.command, managedRoots);
  if (commandProfile) {
    const recovered = {
      browser: browserName,
      account: accountName,
      profile: commandProfile,
      port,
      startedAt: new Date().toISOString(),
      recoveredFromProcess: true,
      legacyProfile: commandProfile !== path.resolve(profile),
      pid: listener.pid,
    };
    writeSession(recovered);
    return { endpoint, activeSession: recovered, recovered: true };
  }

  if (allowDifferentAccount && activeIsManaged) {
    return { endpoint, activeSession: active, recovered: false };
  }
  throw new Error(
    `CDP port ${port} is already in use by an unmanaged or different-account browser. Close it before reusing ${browserName} for account '${accountName}'.`
  );
}
