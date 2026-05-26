/**
 * Memory audit extension — triggers background memory audit after each turn.
 *
 * Listens for `turn_end` events and spawns the memory-audit script
 * as a background process. The script processes only new conversation lines
 * since the last audit (tracked in ~/.pi/agent/memories/.last-audit-lines).
 *
 * Cooldown: file-based, 5 minutes between audits to avoid excessive runs.
 * Uses a shared lockfile so all concurrent processes coordinate.
 *
 * Usage: Place in ~/.pi/agent/extensions/memory-audit.ts
 * Auto-discovered and hot-reloaded via /reload.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync, existsSync, readFileSync } from "node:fs";

const COOLDOWN_FILE = "~/.pi/agent/memories/.audit-cooldown";
const MARKER_FILE = "~/.pi/agent/memories/.last-audit-marker";
const COOLDOWN_SEC = 300; // 5 minutes

function touchCooldown(): boolean {
  const expanded = COOLDOWN_FILE.replace("~", process.env.HOME ?? "/Users/dansmart");

  try {
    const now = Date.now();
    if (existsSync(expanded)) {
      const last = parseInt(readFileSync(expanded, "utf8").trim(), 10);
      if (!isNaN(last) && now - last < COOLDOWN_SEC * 1000) {
        return false; // Still in cooldown
      }
    }
    writeFileSync(expanded, String(now));
    return true; // Claimed the slot
  } catch {
    return false;
  }
}

/**
 * Read the first line of a file to extract a session identifier.
 * Looks for a session_id field in the first JSON object, or falls back to filename.
 */
function getSessionId(filePath: string): string {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buf, 0, 4096);
    fs.closeSync(fd);
    const text = buf.slice(0, bytesRead).toString("utf8");
    const firstLine = text.split("\n")[0];
    if (!firstLine) return path.basename(filePath);
    try {
      const obj = JSON.parse(firstLine);
      if (obj.session_id) return String(obj.session_id);
    } catch {
      // Not valid JSON — fall through to filename
    }
    return path.basename(filePath);
  } catch {
    return path.basename(filePath);
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("turn_end", async (event, ctx) => {
    if (!touchCooldown()) {
      return; // Another process already claimed the cooldown window
    }

    // Schedule the memory audit as a detached background process.
    // nohup + redirect ensures it survives the pi process lifecycle.
    const { exec } = await import("node:child_process");

    exec(
      `nohup bash -c '~/.pi/agent/bin/memory-audit' </dev/null >/dev/null 2>&1 &`,
      () => {
        // Silently ignore errors — the audit is fire-and-forget
      },
    );
  });
}
