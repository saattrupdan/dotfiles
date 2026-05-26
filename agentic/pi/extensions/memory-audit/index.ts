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
 * Usage: Place in ~/.pi/agent/extensions/memory-audit/index.ts
 * Auto-discovered and hot-reloaded via /reload.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PI = join(process.env.HOME ?? "/Users/dansmart", ".pi", "agent");
const COOLDOWN_FILE = join(PI, "memories", ".audit-cooldown");
const AUDIT_SCRIPT = join(PI, "bin", "memory-audit");
const COOLDOWN_SEC = 300; // 5 minutes

function touchCooldown(): boolean {
  try {
    const now = Date.now();
    if (existsSync(COOLDOWN_FILE)) {
      const last = parseInt(readFileSync(COOLDOWN_FILE, "utf8").trim(), 10);
      if (!isNaN(last) && now - last < COOLDOWN_SEC * 1000) {
        return false; // Still in cooldown
      }
    }
    writeFileSync(COOLDOWN_FILE, String(now));
    return true; // Claimed the slot
  } catch {
    return false;
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
      `nohup bash -c '${AUDIT_SCRIPT}' </dev/null >/dev/null 2>&1 &`,
      () => {
        // Silently ignore errors — the audit is fire-and-forget
      },
    );
  });
}
