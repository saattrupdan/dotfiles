/** Launch only the curated sandbox profile inside the already isolated guest. */
import * as fs from "node:fs";
import * as path from "node:path";
import { buildProfileArgs, loadProfile, piCli, runCli } from "../profile/launcher.mjs";

if (process.platform !== "linux" || !fs.existsSync("/run/pi-sandbox")) throw new Error("Sandbox guest environment required");
const resources = process.env.PI_CODING_AGENT_DIR;
const agentDir = path.join(process.env.HOME, ".pi/agent");
fs.mkdirSync(agentDir, { recursive: true });
for (const name of ["agents", "extensions", "skills", "profile", "sandbox", "themes"]) {
	fs.symlinkSync(path.join(resources, name), path.join(agentDir, name));
}
fs.copyFileSync(path.join(resources, "settings.json"), path.join(agentDir, "settings.json"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const pkg = process.env.PI_PACKAGE_DIR;
const profile = await loadProfile("sandbox", agentDir, pkg);
const model = JSON.parse(fs.readFileSync("/mailbox/model.json", "utf8"));
const settingsPath = path.join(agentDir, "settings.json");
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
Object.assign(settings, { defaultProvider: model.provider, defaultModel: model.id });
fs.writeFileSync(settingsPath, JSON.stringify(settings));
// Keep native reload/worktree supervision entirely inside this container.
fs.mkdirSync(path.join(agentDir, "profile-sessions"), { recursive: true });
fs.symlinkSync("/sessions", path.join(agentDir, "profile-sessions/sandbox"));
process.env.PI_CODING_AGENT_SESSION_DIR = "/sessions";
const userArgs = process.argv.slice(2);
const args = buildProfileArgs(profile, agentDir, userArgs);
process.exitCode = await runCli(piCli(pkg), args, process.env, { profile, agentDir, pkg, userArgs, cwd: process.cwd(), fixedModel: { provider: model.provider, id: model.id } });
