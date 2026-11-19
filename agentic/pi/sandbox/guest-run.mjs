/** Launch only the curated sandbox profile inside the already isolated guest. */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { buildProfileArgs, loadProfile, piCli } from "../profile/launcher.mjs";

if (process.platform !== "linux" || !fs.existsSync("/run/pi-sandbox")) throw new Error("Sandbox guest environment required");
const resources = process.env.PI_CODING_AGENT_DIR;
const agentDir = path.join(process.env.HOME, ".pi/agent");
fs.mkdirSync(agentDir, { recursive: true });
for (const name of ["agents", "extensions", "skills", "profile", "sandbox"]) {
	fs.symlinkSync(path.join(resources, name), path.join(agentDir, name));
}
fs.copyFileSync(path.join(resources, "settings.json"), path.join(agentDir, "settings.json"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const pkg = process.env.PI_PACKAGE_DIR;
const profile = await loadProfile("sandbox", agentDir, pkg);
const model = JSON.parse(fs.readFileSync("/mailbox/model.json", "utf8"));
const args = buildProfileArgs(profile, agentDir, process.argv.slice(2));
// Session storage and the one host-approved model are launcher-owned, not repo config.
args.push("--session-dir", "/sessions", "--provider", model.provider, "--model", model.id);
const child = spawn(process.execPath, [piCli(pkg), ...args], { stdio: "inherit", env: process.env });
const forward = (signal) => child.kill(signal);
process.on("SIGINT", forward);
process.on("SIGTERM", forward);
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = signal ? 130 : code ?? 1; });
