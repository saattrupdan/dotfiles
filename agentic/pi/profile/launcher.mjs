/* Select a top-level agent profile before Pi loads its prompt or extensions. */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseAgentProfile } from "./definition.mjs";

const NAME = /^[a-z][a-z0-9-]*$/;
const PROFILE_DIR = "profile-sessions";
const RESOURCE_FLAGS = new Set([
	"--system-prompt", "--append-system-prompt", "--tools", "-t", "--exclude-tools", "-xt",
	"--no-tools", "-nt", "--no-builtin-tools", "-nbt", "--extension", "-e",
	"--no-extensions", "-ne", "--no-mcp", "--skill", "--no-skills", "-ns",
	"--model", "--provider", "--session-dir",
]);

export function selectProfile(argv) {
	let agent = "main";
	let chosen = false;
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") return { agent, args: [...rest, ...argv.slice(i)] };
		if (arg === "--agent" || arg.startsWith("--agent=")) {
			if (chosen) throw new Error("--agent may only be specified once");
			agent = arg === "--agent" ? argv[++i] : arg.slice("--agent=".length);
			if (!agent || !NAME.test(agent)) throw new Error("--agent needs a simple profile name");
			chosen = true;
		} else {
			rest.push(arg);
		}
	}
	return { agent, args: rest };
}

export function resolvePiPackage(env = process.env) {
	if (env.PI_CLI_PACKAGE) return path.resolve(env.PI_CLI_PACKAGE);
	const npm = path.join(path.dirname(process.execPath), "npm");
	const root = execFileSync(fs.existsSync(npm) ? npm : "npm", ["root", "-g"], {
		encoding: "utf8", env: { ...env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? ""}` },
	}).trim();
	return path.join(root, "@earendil-works", "pi-coding-agent");
}

export function piCli(pkg) {
	const manifest = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8"));
	const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
	if (!entry) throw new Error(`Pi CLI not found in ${pkg}`);
	return path.resolve(pkg, entry);
}

export async function loadProfile(agent, agentDir, piPackage) {
	const filePath = path.join(agentDir, "agents", `${agent}.md`);
	const content = fs.readFileSync(filePath, "utf8");
	const parser = await import(pathToFileURL(path.join(piPackage, "dist", "utils", "frontmatter.js")).href);
	const { frontmatter, body } = parser.parseFrontmatter(content);
	const profile = parseAgentProfile(frontmatter, body, filePath);
	if (profile.name !== agent || profile.subagent) {
		throw new Error(`${filePath}: top-level profile must match its filename and set subagent: false`);
	}
	if (profile.extensions === undefined || profile.tools === undefined || profile.skills === undefined) {
		throw new Error(`${filePath}: top-level profile needs tools, skills and extensions allow-lists`);
	}
	return profile;
}

function within(target, root) {
	const relative = path.relative(root, target);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function canonical(target) {
	const absolute = path.resolve(target);
	return fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute;
}

/** Reject explicit paths that would resume another profile under the wrong tools. */
export function checkSessionPaths(args, agent, agentDir, cwd = process.cwd(), sessionEnv) {
	const root = canonical(path.join(agentDir, PROFILE_DIR));
	const own = path.join(root, agent);
	if (agent === "main" && sessionEnv && within(canonical(path.resolve(cwd, sessionEnv)), root)) {
		throw new Error("Main cannot resume a private profile through PI_CODING_AGENT_SESSION_DIR");
	}
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") break;
		const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
		if (flag !== "--session" && flag !== "--fork" && flag !== "--session-dir") continue;
		const value = inline ?? args[++i];
		if (!value) throw new Error(`${flag} needs a value`);
		if (flag === "--session-dir") {
			if (agent !== "main" || within(canonical(path.resolve(cwd, value)), root)) {
				throw new Error("Profile session storage cannot be overridden");
			}
			continue;
		}
		if (!value.includes("/") && !value.includes("\\") && !value.endsWith(".jsonl")) continue;
		const target = canonical(path.resolve(cwd, value));
		if (agent === "main" ? within(target, root) : !within(target, own)) {
			throw new Error(`${flag} cannot open a session from another agent profile`);
		}
	}
}

function promptFile(profile, agentDir) {
	const dir = path.join(agentDir, "profile-prompts");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const hash = createHash("sha256").update(profile.systemPrompt).digest("hex");
	const file = path.join(dir, `${profile.name}-${hash}.md`);
	if (!fs.existsSync(file)) {
		const temp = path.join(dir, `.${profile.name}-${process.pid}-${hash}.tmp`);
		fs.writeFileSync(temp, profile.systemPrompt, { mode: 0o600 });
		fs.renameSync(temp, file);
	}
	return file;
}

export function buildProfileArgs(profile, agentDir, args, cwd = process.cwd(), sessionEnv) {
	if (profile.subagent || profile.tools === undefined || profile.skills === undefined || profile.extensions === undefined) {
		throw new Error(`${profile.name}: top-level profile requires subagent: false and explicit resource allow-lists`);
	}
	checkSessionPaths(args, profile.name, agentDir, cwd, sessionEnv);
	if (profile.name !== "main") {
		for (const arg of args) {
			if (arg === "--") break;
			const flag = arg.split("=", 1)[0];
			if (RESOURCE_FLAGS.has(flag)) throw new Error(`${flag} cannot override the ${profile.name} profile`);
		}
	}
	const flags = ["--system-prompt", promptFile(profile, agentDir), "--no-extensions"];
	// Preserve explicit main-session opt-outs used by lightweight helper processes.
	if (profile.name !== "main" || !args.includes("--no-extensions")) {
		for (const name of profile.extensions) {
			if (name === "mcp" || name === "codemode") {
				flags.push("--extension", `builtin:${name}`);
				continue;
			}
			const extension = path.join(agentDir, "extensions", name);
			if (!fs.existsSync(path.join(extension, "index.ts"))) throw new Error(`Missing profile extension: ${name}`);
			flags.push("--extension", extension);
		}
	}
	if (profile.name !== "main") {
		if (profile.extensions.includes("mcp-collapse")) throw new Error("Private profiles cannot load the general MCP gateway");
		flags.push("--no-mcp", "--session-dir", path.join(agentDir, PROFILE_DIR, profile.name));
	}
	if (profile.skills !== undefined) {
		flags.push("--no-skills");
		for (const skill of profile.skills) {
			const skillDir = path.join(agentDir, "skills", skill);
			if (!fs.existsSync(path.join(skillDir, "SKILL.md"))) {
				if (profile.name !== "main") throw new Error(`Missing profile skill: ${skill}`);
				console.error(`pi profile: main skill ${skill} is not installed; skipping`);
				continue;
			}
			flags.push("--skill", skillDir);
		}
	}
	if (profile.tools !== undefined) flags.push(profile.tools.length ? "--tools" : "--no-tools", ...(profile.tools.length ? [profile.tools.join(",")] : []));
	if (profile.model?.length) flags.push("--model", profile.model[0]);
	return [...flags, ...args];
}

export async function main(argv = process.argv.slice(2), env = process.env) {
	const pkg = resolvePiPackage(env);
	const cli = piCli(pkg);
	const { agent, args } = selectProfile(argv);
	// Administrative commands do not create agent sessions.
	if (agent === "main" && (args[0]?.startsWith("-") && ["--help", "-h", "--version", "-v"].includes(args[0]) ||
		["install", "remove", "uninstall", "update", "list", "config", "auth", "mcp"].includes(args[0]))) {
		return runCli(cli, args, env);
	}
	const agentDir = env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	const profile = await loadProfile(agent, agentDir, pkg);
	return runCli(cli, buildProfileArgs(profile, agentDir, args, process.cwd(), env.PI_CODING_AGENT_SESSION_DIR), env);
}

function runCli(cli, args, env) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [cli, ...args], { stdio: "inherit", env });
		const forward = (signal) => child.kill(signal);
		process.on("SIGINT", forward);
		process.on("SIGTERM", forward);
		child.on("error", reject);
		child.on("close", (code, signal) => {
			process.off("SIGINT", forward);
			process.off("SIGTERM", forward);
			resolve(signal ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 1));
		});
	});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().then((code) => { process.exitCode = code; }, (error) => {
		console.error(`pi profile: ${error.message}`);
		process.exitCode = 1;
	});
}
