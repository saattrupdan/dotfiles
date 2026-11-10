/** Resolve native startup selectors without opening a session for mutation. */
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import {
	acquire,
	reserveId,
	reserveNamespace,
	newOwner,
	lockRoot,
	OWNERSHIP_ENV,
	SUPPORTED_PI_VERSION,
} from "../extensions/_session_ownership/ownership.mjs";
const SELECTORS = new Set([
	"--session",
	"--session-id",
	"--fork",
	"--resume",
	"-r",
	"--continue",
	"-c",
]);
export function stripSelectors(args) {
	const rest = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--") {
			rest.push(...args.slice(i));
			break;
		}
		const flag = args[i].split("=")[0];
		if (SELECTORS.has(flag)) {
			if (["--session", "--session-id", "--fork"].includes(flag) && !args[i].includes("=")) i++;
		} else rest.push(args[i]);
	}
	return rest;
}
export async function prepareOwnedLaunch(args, pkg, env = process.env, cwd = process.cwd()) {
	const version = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).version;
	if (version !== SUPPORTED_PI_VERSION)
		throw new Error(
			`Ownership requires tested Pi ${SUPPORTED_PI_VERSION}; installed ${version}. Rerun compatibility proofs before updating the pin.`,
		);

	const { parseArgs } = await import(pathToFileURL(path.join(pkg, "dist", "cli", "args.js")).href);
	const { SessionManager, findMostRecentSession } = await import(
		pathToFileURL(path.join(pkg, "dist", "core", "session-manager.js")).href
	);
	const parsed = parseArgs(args);
	const selectors = [parsed.session, parsed.fork, parsed.resume, parsed.continue].filter(
		Boolean,
	).length;
	if (selectors > 1 || (parsed.sessionId && selectors && !parsed.fork))
		throw new Error("Conflicting saved-session selectors");
	const root = lockRoot(env);
	const owner = newOwner(env.PI_REMOTE_MANAGED ? "tmux" : "local");
	const sessionDir = parsed.sessionDir || env.PI_CODING_AGENT_SESSION_DIR;
	if (parsed.noSession) {
		if (selectors || parsed.sessionId)
			throw new Error("--no-session cannot bypass protected saved-session selectors");
		if (parsed.print && parsed.noExtensions) {
			const clean = { ...env };
			delete clean[OWNERSHIP_ENV];
			return { args, env: clean };
		}
	}

	if (parsed.noExtensions && !parsed.extensions?.some((file) => file.endsWith("session-ownership")))
		throw new Error(
			"Saved main sessions require ownership guards; helper opt-outs must use --no-session",
		);
	const all = async () => SessionManager.listAll(sessionDir);
	let target;
	const explicit = parsed.session || parsed.fork;
	if (explicit) {
		if (explicit.includes("/") || explicit.endsWith(".jsonl")) {
			target = path.resolve(cwd, explicit);
			if (!fs.existsSync(target)) throw new Error("Session file not found");
		} else {
			const rows = (await all()).filter((s) => s.id.startsWith(explicit));
			if (rows.length !== 1) throw new Error("Session ID missing or ambiguous");
			target = rows[0].path;
		}
	} else if (parsed.continue) {
		const defaultDir = path.join(
			env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
			"sessions", `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
		);
		target = findMostRecentSession(sessionDir || defaultDir, cwd) || undefined;
	} else if (parsed.sessionId) target = SessionManager.findById(cwd, parsed.sessionId, sessionDir);
	else if (parsed.resume) {
		if (!process.stdin.isTTY)
			throw new Error("Startup --resume picker requires a terminal; use --session PATH");
		const rows = await all();
		if (!rows.length) throw new Error("No saved sessions");
		rows.sort((a, b) => +b.modified - +a.modified);
		rows.forEach((s, i) => console.log(`${i + 1}. ${s.name || s.firstMessage || s.id} [${s.cwd}]`));
		const input = createInterface({ input: process.stdin, output: process.stdout });
		try {
			const choice = Number(await input.question("Resume session number (blank cancels): "));
			if (!Number.isInteger(choice) || choice < 1 || choice > rows.length)
				throw new Error("Resume cancelled");
			target = rows[choice - 1].path;
		} finally {
			input.close();
		}
	}
	// New/fork filenames are allocated by Pi. Block competing opens until session_start binds them.
	reserveNamespace(owner, root);
	const newId =
		!parsed.noSession && (parsed.fork || !target) ? parsed.sessionId || randomUUID() : undefined;
	if (newId) reserveId(newId, owner, root);
	if (target) acquire(target, owner, root);
	const normalized = stripSelectors(args);
	const selection = [];
	if (parsed.fork) {
		selection.push("--fork", target);
		if (newId) selection.push("--session-id", newId);
	} else if (target) selection.push("--session", target);
	else if (newId) selection.push("--session-id", newId);
	const terminator = normalized.indexOf("--");
	normalized.splice(terminator < 0 ? normalized.length : terminator, 0, ...selection);
	return { args: normalized, env: { ...env, [OWNERSHIP_ENV]: JSON.stringify(owner) } };
}
