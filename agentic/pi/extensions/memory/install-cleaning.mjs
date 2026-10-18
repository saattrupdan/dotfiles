#!/usr/bin/env node
/** Install the macOS hourly librarian job with catch-up after login and wake. */

import console from "node:console";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const LABEL = "com.saattrupdan.pi-memory-cleaning";
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "clean.mjs");
function xml(value) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}
export function plist({ nodePath, scriptPath, logPath }) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(scriptPath)}</string></array>
  <key>StartCalendarInterval</key><dict><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict></plist>
`;
}
export function install({ home = os.homedir(), execute = spawnSync,
	nodePath = fs.existsSync("/opt/homebrew/bin/node") ? "/opt/homebrew/bin/node" : process.execPath } = {}) {
	const root = path.join(home, "memory");
	if (!fs.statSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error("Memory bundle must exist");
	const agents = path.join(home, "Library", "LaunchAgents");
	fs.mkdirSync(agents, { recursive: true, mode: 0o700 });
	const config = path.join(agents, `${LABEL}.plist`);
	const temp = `${config}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(temp, plist({ nodePath, scriptPath: script, logPath: path.join(root, "cleaning.log") }),
			{ flag: "wx", mode: 0o600 });
		fs.renameSync(temp, config);
	} finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
	const target = `gui/${process.getuid()}/${LABEL}`;
	const invoke = (args) => execute("launchctl", args, { encoding: "utf8" });
	if (invoke(["print", target]).status === 0) {
		const removed = invoke(["bootout", target]);
		if (removed.status !== 0) throw new Error(`Could not unload previous cleaner: ${removed.stderr}`);
	}
	const started = invoke(["bootstrap", `gui/${process.getuid()}`, config]);
	if (started.status !== 0) throw new Error(`Could not start hourly cleaner: ${started.stderr}`);
	return { config, target };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { console.log(JSON.stringify(install())); }
	catch (error) { console.error(error.message); process.exitCode = 1; }
}
