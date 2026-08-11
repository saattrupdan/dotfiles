/* global process */

import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readCache, restoreSnapshotFromCache } from "./refresh.mjs";

const SNAPSHOT_FILE = path.join(os.homedir(), ".pi", "agent", "memory-snapshot.md");
const CACHE_FILE = path.join(os.homedir(), ".pi", "agent", "memory-snapshot.json");
const PID_FILE = path.join(os.homedir(), ".pi", "agent", "memory-snapshot.pid");
const DAEMON_SCRIPT = fileURLToPath(new URL("./refresh.mjs", import.meta.url));

let daemonProcess: ChildProcess | null = null;
let ownedDaemonPid: number | null = null;

function readSnapshot(): string | null {
	try {
		if (!fs.existsSync(SNAPSHOT_FILE)) return null;
		return fs.readFileSync(SNAPSHOT_FILE, "utf-8");
	} catch {
		// A concurrently removed or unreadable snapshot is not safe to inject.
		return null;
	}
}

function ensureSnapshotSync(): void {
	if (fs.existsSync(SNAPSHOT_FILE)) return;
	const cache = readCache(CACHE_FILE);
	if (cache) {
		try {
			restoreSnapshotFromCache({ cacheFile: CACHE_FILE, snapshotFile: SNAPSHOT_FILE }, cache);
		} catch {
			// Leave the cache untouched when atomic restoration cannot complete.
		}
	}
}

function readPidFile(): number | null {
	try {
		const value = Number.parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
		return Number.isSafeInteger(value) && value > 0 ? value : null;
	} catch {
		return null;
	}
}

function removePidFileIfOwned(pid: number): void {
	if (ownedDaemonPid !== pid || readPidFile() !== pid) return;
	try {
		fs.unlinkSync(PID_FILE);
	} catch {
		// The daemon may have removed its PID file concurrently.
	}
}

function isMissingProcessError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

function startDaemon(): void {
	if (daemonProcess) return;
	const existingPid = readPidFile();
	if (existingPid !== null) {
		try {
			process.kill(existingPid, 0);
			return;
		} catch (error) {
			if (!isMissingProcessError(error)) return;
			// A dead PID is stale; only remove the value that was just checked.
			if (readPidFile() === existingPid) {
				try {
					fs.unlinkSync(PID_FILE);
				} catch {
					// Another process may have cleaned up the stale file.
				}
			}
		}
	}
	daemonProcess = spawn("node", [DAEMON_SCRIPT, "--daemon"], {
		stdio: ["ignore", "pipe", "pipe"],
		detached: false,
	});
	const child = daemonProcess;
	if (child.pid) {
		ownedDaemonPid = child.pid;
		fs.writeFileSync(PID_FILE, child.pid.toString());
	}
	child.on("exit", () => {
		const pid = child.pid;
		if (pid) removePidFileIfOwned(pid);
		if (daemonProcess === child) daemonProcess = null;
		if (ownedDaemonPid === pid) ownedDaemonPid = null;
	});
}

function stopDaemon(): void {
	const child = daemonProcess;
	const pid = ownedDaemonPid;
	if (child) child.kill("SIGTERM");
	if (pid !== null) removePidFileIfOwned(pid);
	if (daemonProcess === child) daemonProcess = null;
	if (ownedDaemonPid === pid) ownedDaemonPid = null;
}

export function appendSnapshotToSystemPrompt(systemPrompt: string, snapshot: string): string {
	return `${systemPrompt}\n\n${snapshot}`;
}

export function buildBeforeAgentStartResult(
	event: BeforeAgentStartEvent,
	snapshot: string | null,
): BeforeAgentStartEventResult | undefined {
	if (!snapshot) return undefined;
	return { systemPrompt: appendSnapshotToSystemPrompt(event.systemPrompt, snapshot) };
}

export default function api(pi: ExtensionAPI) {
	pi.on("session_start", () => { ensureSnapshotSync(); startDaemon(); });

	pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
		return buildBeforeAgentStartResult(event, readSnapshot());
	});

	pi.on("session_shutdown", () => { stopDaemon(); });
}
