/** Own container lifecycle, curated resources, and host-only model authentication. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createHostModel, startBroker } from "./broker.mjs";
import { sandboxArguments } from "./policy.mjs";
import { runSandboxContainer } from "./container-lifecycle.mjs";

const source = path.dirname(fileURLToPath(import.meta.url));
export const CONTAINER = "/usr/local/bin/container";

export function sandboxImage(pkg) {
	const version = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).version;
	const hash = createHash("sha256").update(version);
	for (const name of ["Containerfile", "entrypoint.sh", "inner.sh"]) hash.update(fs.readFileSync(path.join(source, name)));
	return { tag: `pi-sandbox:${hash.digest("hex").slice(0, 16)}`, version };
}

export function preflightSandbox(pkg) {
	if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Apple sandbox sessions require an Apple Silicon Mac");
	if (!fs.existsSync(CONTAINER)) throw new Error("Install Apple's signed container package, then start its runtime before opening /sandbox");
	try { execFileSync(CONTAINER, ["system", "status"], { stdio: "pipe", timeout: 10000 }); }
	catch { throw new Error("Apple Container is not running. Start its runtime before opening /sandbox"); }
	return sandboxImage(pkg);
}

function copyTree(from, to) {
	fs.cpSync(from, to, { recursive: true, dereference: true, filter: (name) => {
		const base = path.basename(name);
		return !["node_modules", ".git", "auth.json", "models.json", "state", ".DS_Store"].includes(base) && !/\.test\.[cm]?[jt]s$/.test(base);
	} });
}

export async function stageSandboxResources(agentDir, pkg, target) {
	const { loadProfile } = await import("../profile/launcher.mjs");
	const profile = await loadProfile("sandbox", agentDir, pkg);
	fs.mkdirSync(path.join(target, "agents"), { recursive: true });
	fs.copyFileSync(path.join(agentDir, "agents/sandbox.md"), path.join(target, "agents/sandbox.md"));
	copyTree(path.join(agentDir, "profile"), path.join(target, "profile"));
	fs.mkdirSync(path.join(target, "sandbox"), { recursive: true });
	for (const file of ["guest-run.mjs", "guest-provider.mjs", "protocol.mjs", "events.mjs", "policy.mjs", "handoff.mjs"]) {
		fs.copyFileSync(path.join(source, file), path.join(target, "sandbox", file));
	}
	for (const extension of profile.extensions) {
		if (!["codemode", "mcp"].includes(extension)) copyTree(path.join(agentDir, "extensions", extension), path.join(target, "extensions", extension));
	}
	// Shared helper libraries expose no tools by themselves; selected extensions import them.
	for (const entry of fs.readdirSync(path.join(agentDir, "extensions"))) {
		if (entry.startsWith("_") && fs.statSync(path.join(agentDir, "extensions", entry)).isDirectory())
			copyTree(path.join(agentDir, "extensions", entry), path.join(target, "extensions", entry));
	}
	// These are pure render/parser helpers, not the excluded extension factories.
	for (const relative of ["web-browse/command.ts", "mcp-collapse/display.ts"]) {
		const destination = path.join(target, "extensions", relative);
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.copyFileSync(path.join(agentDir, "extensions", relative), destination);
	}
	for (const skill of profile.skills) {
		const candidates = [path.join(agentDir, "skills", skill), path.join(os.homedir(), ".agents/skills", skill)];
		const from = candidates.find((dir) => fs.existsSync(path.join(dir, "SKILL.md")));
		if (!from) throw new Error(`Missing sandbox skill: ${skill}`);
		copyTree(from, path.join(target, "skills", skill));
	}
	const { parseFrontmatter } = await import(`file://${path.join(pkg, "dist/utils/frontmatter.js")}`);
	// User-owned child prompts are copied, but their capabilities can only narrow this profile.
	for (const name of ["builder", "explorer", "planner", "reviewer"]) {
		const file = path.join(agentDir, "agents", `${name}.md`);
		if (!fs.existsSync(file)) continue;
		const { frontmatter, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
		const tools = (frontmatter.tools ?? []).filter((tool) => profile.tools.includes(tool) && tool !== "subagent");
		const extensions = profile.extensions.filter((extension) => !["subagent", "statusline"].includes(extension));
		const fields = { name, description: frontmatter.description ?? name, subagent: true, worktree: frontmatter.worktree ?? false, tools, skills: profile.skills, extensions };
		const header = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
		fs.writeFileSync(path.join(target, "agents", `${name}.md`), `---\n${header}\n---\n${body}\n\nYou run inside the same offline Apple Container as your parent. Never request host execution.\n`);
	}
	// Carry presentation preferences, never host packages, shell settings, or credentials.
	const host = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
	const keys = ["theme", "tuiMode", "quietStartup", "hideThinkingBlock", "collapseChangelog", "editorPaddingX", "autocompleteMaxVisible", "doubleEscapeAction", "defaultThinkingLevel"];
	const settings = Object.fromEntries(keys.filter((key) => Object.hasOwn(host, key)).map((key) => [key, host[key]]));
	if (host.terminal) settings.terminal = Object.fromEntries(["clearOnShrink", "showImages"].filter((key) => typeof host.terminal[key] === "boolean").map((key) => [key, host.terminal[key]]));
	Object.assign(settings, { defaultProjectTrust: "never", packages: [], extensions: [], compaction: { enabled: true } });
	fs.mkdirSync(path.join(target, "themes"), { recursive: true });
	if (settings.theme !== undefined) {
		if (typeof settings.theme !== "string" || !/^[a-zA-Z0-9_-]+$/.test(settings.theme)) throw new Error("Invalid sandbox theme name");
		const theme = path.join(agentDir, "themes", `${settings.theme}.json`);
		if (fs.existsSync(theme)) {
			const relative = path.relative(fs.realpathSync(path.dirname(theme)), fs.realpathSync(theme));
			if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Sandbox theme must stay inside its theme directory");
			fs.copyFileSync(theme, path.join(target, "themes", `${settings.theme}.json`));
		}
	}
	fs.writeFileSync(path.join(target, "settings.json"), JSON.stringify(settings));
	return profile;
}

export function containerArguments({ name, image, root, cwd, resources, mailbox, sessions, cache, uid, gid, args, tty }) {
	for (const value of [root, resources, mailbox, sessions, cache]) {
		if (/[,:\n\r]/.test(value)) throw new Error("Sandbox mount paths cannot contain commas, colons, or newlines");
	}
	const relative = path.relative(root, cwd);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Sandbox cwd must be inside its project");
	return ["run", "--rm", "--name", name, "-i", ...(tty ? ["-t"] : []), "--memory", "4g", "--cpus", "4", "--read-only", "--no-dns",
		"--cap-drop", "ALL", ...["SYS_ADMIN", "NET_ADMIN", "SETUID", "SETGID", "SETPCAP", "CHOWN"].flatMap((cap) => ["--cap-add", cap]),
		"--tmpfs", "/tmp", "--tmpfs", "/run", "--tmpfs", "/home/pi",
		"--mount", `type=bind,source=${root},target=/workspace`,
		"--mount", `type=bind,source=${resources},target=/opt/pi-config,readonly`,
		"--mount", `type=bind,source=${mailbox},target=/mailbox`,
		"--mount", `type=bind,source=${sessions},target=/sessions`,
		"--mount", `type=bind,source=${cache},target=/cache`,
		"--env", `SANDBOX_UID=${uid}`, "--env", `SANDBOX_GID=${gid}`,
		"--workdir", path.posix.join("/workspace", relative.split(path.sep).join("/")), image,
		"node", "/opt/pi-config/sandbox/guest-run.mjs", ...args];
}

async function command(args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(CONTAINER, args, { stdio: "inherit", ...options });
		const forward = (signal) => child.kill(signal);
		process.on("SIGINT", forward);
		process.on("SIGTERM", forward);
		child.on("error", reject);
		child.on("close", (code, signal) => {
			process.off("SIGINT", forward); process.off("SIGTERM", forward);
			resolve(signal ? 130 : code ?? 1);
		});
	});
}

export async function runSandbox({ agentDir, pkg, cwd = process.cwd(), args = [], model }) {
	const image = preflightSandbox(pkg);
	const guestArgs = sandboxArguments(args);
	try { execFileSync(CONTAINER, ["image", "inspect", image.tag], { stdio: "pipe", timeout: 10000 }); }
	catch {
		console.error("📦 Building the shared Pi sandbox image (reused across repositories)…");
		const code = await command(["build", "--build-arg", `PI_VERSION=${image.version}`, "-t", image.tag, "-f", path.join(source, "Containerfile"), source]);
		if (code !== 0) throw new Error("Shared sandbox image build failed; no host session was started");
	}
	let root = fs.realpathSync(cwd);
	while (!fs.existsSync(path.join(root, ".git"))) {
		const parent = path.dirname(root);
		if (parent === root) { root = fs.realpathSync(cwd); break; }
		root = parent;
	}
	if (root === os.homedir() || root === path.parse(root).root) throw new Error("Refusing to mount your home directory or filesystem root as a sandbox project");
	const state = path.join(os.homedir(), ".local/state/pi-sandbox");
	const project = path.join(state, createHash("sha256").update(root).digest("hex").slice(0, 20));
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-"));
	const resources = path.join(temporary, "resources"), mailbox = path.join(temporary, "mailbox");
	for (const directory of [resources, mailbox, path.join(project, "sessions"), path.join(project, "cache")]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	let broker, lifecycleOwnsResources = false;
	const name = `pi-${randomUUID()}`;
	try {
		await stageSandboxResources(agentDir, pkg, resources);
		const host = await createHostModel(pkg, agentDir, model);
		broker = startBroker(mailbox, host);
		console.error("📦 Opening a fresh offline sandbox session. Project changes write through to the host.");
		const containerArgs = containerArguments({ name, image: image.tag, root, cwd: fs.realpathSync(cwd), resources, mailbox,
			sessions: path.join(project, "sessions"), cache: path.join(project, "cache"), uid: process.getuid(), gid: process.getgid(), args: guestArgs, tty: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
		lifecycleOwnsResources = true;
		return await runSandboxContainer({ container: CONTAINER, args: containerArgs, name, temporary });
	} finally {
		await broker?.stop();
		if (!lifecycleOwnsResources) fs.rmSync(temporary, { recursive: true, force: true });
	}
}
