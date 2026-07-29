import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";

const SNAPSHOT_FILE = path.join(os.homedir(), ".pi", "agent", "memory-snapshot.md");
const CACHE_FILE = path.join(os.homedir(), ".pi", "agent", "memory-snapshot.json");
const PID_FILE = path.join(os.homedir(), ".pi", "agent", "memory-snapshot.pid");
const DAEMON_SCRIPT = path.join(os.homedir(), ".pi", "agent", "bin", "memory-snapshot-refresh");

let daemonProcess: any = null;

export default function api(pi: ExtensionAPI) {
	function readSnapshot(): string | null {
		try {
			if (!fs.existsSync(SNAPSHOT_FILE)) return null;
			return fs.readFileSync(SNAPSHOT_FILE, "utf-8");
		} catch { return null; }
	}

	function ensureSnapshotSync(): void {
		if (!fs.existsSync(SNAPSHOT_FILE) && fs.existsSync(CACHE_FILE)) {
			try {
				const cache: any = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
				const snapshotText = [
					"## Memory — Current Contents (auto-generated)",
					"", `*Last memory activity: see cache*`, "", cache.snapshot,
				].join("\n");
				fs.writeFileSync(SNAPSHOT_FILE, snapshotText);
			} catch {}
		}
	}

	function startDaemon(): void {
		if (daemonProcess) return;
		if (fs.existsSync(PID_FILE)) {
			try {
				const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim());
				process.kill(pid, 0);
				return;
			} catch { fs.unlinkSync(PID_FILE); }
		}
		daemonProcess = spawn("node", [DAEMON_SCRIPT, "--daemon"], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: false,
		});
		if (daemonProcess.pid) fs.writeFileSync(PID_FILE, daemonProcess.pid.toString());
		daemonProcess.on("exit", () => {
			daemonProcess = null;
			if (fs.existsSync(PID_FILE)) try { fs.unlinkSync(PID_FILE); } catch {}
		});
	}

	function stopDaemon(): void {
		if (daemonProcess) { daemonProcess.kill("SIGTERM"); daemonProcess = null; }
		if (fs.existsSync(PID_FILE)) try { fs.unlinkSync(PID_FILE); } catch {}
	}

	pi.on("session_start", () => { ensureSnapshotSync(); startDaemon(); });

	pi.on("before_agent_start", (event: any) => {
		const snapshot = readSnapshot();
		if (snapshot && event.systemPrompt) {
			event.systemPrompt += `\n\n${snapshot}`;
		}
	});

	pi.on("session_shutdown", () => { stopDaemon(); });
}
