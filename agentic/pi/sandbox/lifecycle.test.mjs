import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { CONTAINER } from "./runtime.mjs";

const enabled = process.env.PI_SANDBOX_INTEGRATION === "1";
const listing = () => JSON.parse(execFileSync(CONTAINER, ["list", "--all", "--format", "json"], { encoding: "utf8", timeout: 10000 }));

async function ownerExit(signal) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-owner-test-"));
	const project = path.join(root, "project");
	fs.mkdirSync(project);
	execFileSync("git", ["init", "-q", project]);
	const driver = path.join(root, "owner.mjs");
	fs.writeFileSync(driver, `
import { runSandbox } from ${JSON.stringify(new URL("./runtime.mjs", import.meta.url).href)};
import { resolvePiPackage } from ${JSON.stringify(new URL("../profile/launcher.mjs", import.meta.url).href)};
process.exitCode = await runSandbox({ agentDir: ${JSON.stringify(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent"))}, pkg: resolvePiPackage(), cwd: ${JSON.stringify(project)}, args: ["--mode", "rpc", "--no-session"] });
`);
	const env = { ...process.env }; delete env.PI_PROFILE_RELOAD_TOKEN;
	const owner = spawn(process.execPath, [driver], { env, stdio: ["pipe", "pipe", "pipe"] });
	let stdout = "", stderr = "", name;
	owner.stdout.on("data", data => { stdout += data; });
	owner.stderr.on("data", data => { stderr += data; });
	owner.stdin.on("error", () => {});
	try {
		owner.stdin.write(JSON.stringify({ type: "get_state", id: "lifecycle-ready" }) + "\n");
		for (let i = 0; i < 150 && !stdout.includes('"command":"get_state"') && owner.exitCode === null; i++) await delay(100);
		assert.ok(stdout.includes('"command":"get_state"'), "Guest did not reach RPC readiness: " + stderr.slice(-2000));
		name = listing().find(item => item.configuration.mounts.some(mount => mount.destination === "/workspace" && mount.source === fs.realpathSync(project)))?.id;
		assert.ok(name, "Actual session container must exist before closing its owner");
		owner.kill(signal);
		for (let i = 0; i < 50 && listing().some(item => item.id === name); i++) await delay(100);
		assert.ok(!listing().some(item => item.id === name), `${signal}: session owner closed but its container still exists`);
	} finally {
		if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
		if (name && listing().some(item => item.id === name)) execFileSync(CONTAINER, ["delete", "--force", name], { stdio: "pipe", timeout: 20000 });
		owner.stdin.destroy();
		fs.rmSync(root, { recursive: true, force: true });
	}
}

for (const mode of ["hangup", "term", "kill", "quit", "resize"]) {
	test(`actual controlling-terminal ${mode} removes its sandbox container`, { skip: !enabled, timeout: 60000 }, async () => {
		const helper = path.join(import.meta.dirname, "pty-close.test.py");
		const child = spawn("uv", ["run", "--no-project", helper, mode], { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", data => { output += data; });
		child.stderr.on("data", data => { output += data; });
		const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
		assert.equal(code, 0, output.slice(-4000));
	});
}

for (const signal of ["SIGHUP", "SIGTERM", "SIGKILL"]) {
	test(`closing sandbox owner with ${signal} stops and removes its Apple container`, { skip: !enabled, timeout: 45000 }, async () => ownerExit(signal));
}
