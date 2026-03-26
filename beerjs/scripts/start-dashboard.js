import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 8080);

function killOnWindows(port) {
  let output = "";
  try {
    output = execSync(`netstat -ano | findstr :${port}`, { stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
  } catch {
    // No listeners found.
    return;
  }

  const pids = new Set();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const localAddress = parts[1] || "";
    const state = parts[3] || "";
    const pid = parts[4] || parts[parts.length - 1];

    // Kill listeners and waiters on the exact port only.
    if (!localAddress.endsWith(`:${port}`)) continue;
    if (!["LISTENING", "ESTABLISHED", "TIME_WAIT", "CLOSE_WAIT"].includes(state)) continue;
    if (!pid || Number.isNaN(Number(pid))) continue;

    pids.add(pid);
  }

  for (const pid of pids) {
    try {
      execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
      console.log(`[dashboard] Killed PID ${pid} on port ${port}`);
    } catch {
      // Ignore failures for stale or privileged processes.
    }
  }
}

function killOnUnix(port) {
  let output = "";
  try {
    output = execSync(`lsof -ti tcp:${port}`, { stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
  } catch {
    return;
  }

  const pids = output
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGKILL");
      console.log(`[dashboard] Killed PID ${pid} on port ${port}`);
    } catch {
      // Ignore failures.
    }
  }
}

if (os.platform() === "win32") {
  killOnWindows(DASHBOARD_PORT);
} else {
  killOnUnix(DASHBOARD_PORT);
}

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(thisDir, "..", "dashboard_server.js");
await import(pathToFileURL(serverPath).href);
