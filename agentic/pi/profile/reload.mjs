/** Prepare a profile-only relaunch without replaying startup input. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SELECTORS = new Set(["--session", "--session-id", "--fork"]);
const SWITCHES = new Set(["--continue", "-c", "--resume", "-r"]);
const VALUES = new Set([
	"--provider",
	"--model",
	"--api-key",
	"--tui-mode",
	"--system-prompt",
	"--append-system-prompt",
	"--thinking",
	"--session-dir",
	"--tools",
	"-t",
	"--exclude-tools",
	"-xt",
	"--extension",
	"-e",
	"--skill",
	"--prompt-template",
	"--theme",
	"--use-theme",
	"--name",
	"--models",
	"--mode",
	"--export",
]);
const PATHS = new Set([
	"--session-dir",
	"--extension",
	"-e",
	"--skill",
	"--prompt-template",
	"--theme",
]);

/** Keep persistent worktree metadata, never replay consumed startup actions. */
export function profileReloadEnvironment(env) {
	const next = { ...env };
	for (const key of [
		"PI_WORKTREE_BRANCH_CONTINUATION",
		"PI_WORKTREE_CLEANUP_CONTINUATION",
		"PI_WORKTREE_LOOP_RETURN_CONTINUATION",
		"PI_LOOP_HANDOFF",
		"PI_PROFILE_RELOAD_REPLACING",
	])
		delete next[key];
	return next;
}

export function profileStamp(profile) {
	return createHash("sha256").update(JSON.stringify(profile)).digest("hex");
}

export function profileReloadEnabled(args) {
	for (const arg of args) {
		if (arg === "--") break;
		if (arg === "--no-extensions" || arg === "-ne") return false;
	}
	return true;
}

/** Keep invocation options, not the old selector, startup prompts or @files. */
export function profileResumeArgs(args, state, originalCwd) {
	const kept = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") break;
		const flag = arg.split("=", 1)[0];
		if (SWITCHES.has(flag)) continue;
		if (SELECTORS.has(flag) || flag === "--name" || flag === "-n") {
			if (!arg.includes("=")) i++;
			continue;
		}
		if (!arg.startsWith("-")) continue;
		let value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : undefined;
		if (value === undefined && (VALUES.has(flag) || state.stringFlags?.includes(flag)))
			value = args[++i];
		if (value !== undefined) {
			if (PATHS.has(flag) && !/^(?:builtin:|npm:|https?:|git:)/.test(value))
				value = path.resolve(originalCwd, value);
			if (
				["--system-prompt", "--append-system-prompt"].includes(flag) &&
				fs.existsSync(path.resolve(originalCwd, value))
			)
				value = path.resolve(originalCwd, value);
			kept.push(flag, value);
		} else kept.push(arg);
	}
	kept.push(
		state.saved ? "--session" : "--session-id",
		state.saved ? state.sessionFile : state.sessionId,
	);
	if (state.name) kept.push("--name", state.name);
	return kept;
}

export function prepareProfileReload(identity, profile, state, buildProfileArgs) {
	if (profileStamp(profile) === profileStamp(identity.profile)) return undefined;
	if (!state || typeof state.cwd !== "string" || typeof state.sessionId !== "string")
		throw new Error("Profile reload has no live session identity");
	if (!state.sessionFile)
		throw new Error(
			"Profile changed, but this session is in memory. No conversation was written; restart it explicitly to apply the profile.",
		);
	if (state.leafId !== state.tipId)
		throw new Error(
			"Profile changed while viewing an earlier branch. Return to the latest branch before reloading.",
		);
	if (state.mode !== "tui")
		throw new Error(
			"Profile changed outside the TUI. Restart explicitly to apply it without interrupting the command response.",
		);
	const cwd = fs.realpathSync(state.cwd);
	const saved = fs.existsSync(state.sessionFile);
	if (!saved && !state.empty)
		throw new Error("The conversation has no saved file; profile reload was not applied");
	if (
		(identity.env.PI_SESSION_OWNER || state.owner) &&
		!profile.extensions.includes("session-ownership")
	)
		throw new Error("Protected sessions must retain the session-ownership extension");
	const next = { ...state, saved };
	const args = profileResumeArgs(identity.userArgs, next, identity.cwd);
	const terminator = identity.userArgs.indexOf("--");
	const options = terminator < 0 ? identity.userArgs : identity.userArgs.slice(0, terminator);
	const explicitModel = options.some((arg) => arg === "--model" || arg.startsWith("--model="));
	const built = buildProfileArgs(
		profile,
		identity.agentDir,
		args,
		cwd,
		identity.env.PI_CODING_AGENT_SESSION_DIR,
	);
	// These are live session state, not user resource overrides of a private profile.
	if (
		(explicitModel || JSON.stringify(identity.profile.model) === JSON.stringify(profile.model)) &&
		state.model
	)
		built.push("--provider", state.model.provider, "--model", state.model.id);
	if (state.thinking) built.push("--thinking", state.thinking);
	return { profile, args, built, cwd };
}
