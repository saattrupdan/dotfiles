/**
 * Relaunch top-level Pi sessions in detached Git worktrees and automatically
 * finalize their repository state after every agent run.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createLaunchPlan,
	enforceRepository,
	findCommonGitDir,
	findManifestForCwd,
	loadManifest,
	type SessionManifest,
} from "./git.ts";

const CHILD_MANIFEST_ENV = "PI_WORKTREE_SESSION_MANIFEST";
const DISABLE_ENV = "PI_WORKTREE_ISOLATION_DISABLE";
const CUSTOM_TYPE = "git-worktree-isolation:finalize";
const MAX_REPAIR_TURNS = 6;

const SYSTEM_INSTRUCTION = `You are running in a detached, isolated Git worktree managed by Pi.
Before concluding any turn that changes files, commit all intended changes and leave the worktree clean.
You may explicitly create or switch to a named feature branch and use a PR workflow. Pi will preserve such a branch and will not merge it automatically.
If you remain on detached HEAD, Pi will automatically publish your commits to the branch from which this session started.
Never bypass, remove, or alter the Pi worktree metadata.`;

function cliArgs(): string[] {
	return process.argv.slice(2);
}

function isMetadataInvocation(args: string[]): boolean {
	const command = args[0];
	if (["install", "remove", "uninstall", "update", "list", "config", "auth"].includes(command ?? "")) return true;
	return args.some((arg) => ["--help", "-h", "--version", "-v", "--list-models", "--export"].includes(arg));
}

function isLegacyResumeInvocation(args: string[]): boolean {
	return args.some((arg) => ["--continue", "-c", "--resume", "-r", "--session"].includes(arg));
}

function fatal(message: string): never {
	process.stderr.write(`Pi worktree isolation: ${message}\n`);
	process.exit(2);
}

async function extensionCwd(pi: ExtensionAPI): Promise<string> {
	const result = await pi.exec("pwd", []);
	if (result.code !== 0 || !result.stdout.trim()) throw new Error("Could not determine Pi's session cwd.");
	return path.resolve(result.stdout.trim());
}

function relaunch(plan: Awaited<ReturnType<typeof createLaunchPlan>>, args = cliArgs()): never {
	const result = spawnSync(process.execPath, [process.argv[1]!, ...args], {
		cwd: plan.childCwd,
		stdio: "inherit",
		env: { ...process.env, [CHILD_MANIFEST_ENV]: plan.manifest.manifestPath },
	});
	if (result.error) fatal(`could not relaunch Pi: ${result.error.message}`);
	process.exit(result.status ?? (result.signal === "SIGINT" ? 130 : 1));
}

function resumeInManagedWorktree(sessionFile: string, cwd: string, manifestPath: string): never {
	const env: NodeJS.ProcessEnv = { ...process.env, [CHILD_MANIFEST_ENV]: manifestPath };
	const result = spawnSync(process.execPath, [process.argv[1]!, "--session", sessionFile], {
		cwd,
		stdio: "inherit",
		env,
	});
	if (result.error) fatal(`could not resume the selected worktree session: ${result.error.message}`);
	process.exit(result.status ?? (result.signal === "SIGINT" ? 130 : 1));
}

function isBareDone(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const candidate = message as { role?: string; content?: unknown };
	if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return false;
	const text = candidate.content
		.map((part) =>
			part && typeof part === "object" && (part as { type?: string }).type === "text"
				? String((part as { text?: unknown }).text ?? "")
				: "",
		)
		.join("")
		.trim()
		.toLowerCase();
	return text === "done" || text === "done.";
}

function forkChildArgs(sessionFile: string): string[] {
	const args = cliArgs();
	const result: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--fork" || arg === "--session-id") {
			index++;
			continue;
		}
		if (arg.startsWith("--fork=") || arg.startsWith("--session-id=")) continue;
		result.push(arg);
	}
	return ["--session", sessionFile, ...result];
}

async function rewriteSessionCwd(sessionFile: string, cwd: string): Promise<void> {
	const content = await fs.promises.readFile(sessionFile, "utf8");
	const newline = content.indexOf("\n");
	if (newline < 0) throw new Error(`Fork session has no header line: ${sessionFile}`);
	const header = JSON.parse(content.slice(0, newline)) as { type?: unknown; cwd?: unknown };
	if (header.type !== "session") throw new Error(`Fork session has an invalid header: ${sessionFile}`);
	header.cwd = cwd;
	const temporary = `${sessionFile}.${process.pid}.tmp`;
	await fs.promises.writeFile(temporary, `${JSON.stringify(header)}\n${content.slice(newline + 1)}`, "utf8");
	await fs.promises.rename(temporary, sessionFile);
}

async function sessionCwd(sessionFile: string): Promise<string | null> {
	try {
		const handle = await fs.promises.open(sessionFile, "r");
		try {
			const buffer = Buffer.alloc(16 * 1024);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
			const header = JSON.parse(firstLine) as { cwd?: unknown };
			return typeof header.cwd === "string" ? path.resolve(header.cwd) : null;
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}
}

function registerManagedSession(pi: ExtensionAPI, manifest: SessionManifest): void {
	let repairTurns = 0;
	let repairMessageActive = false;
	let enforcementRunning = false;

	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections["git-worktree-isolation"] = SYSTEM_INSTRUCTION;
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus("git-worktree-isolation", `🌳 ${manifest.id}`);
	});

	// AgentSession explicitly drains messages queued by agent_end handlers before
	// emitting agent_settled. Queue repair here so TUI, print, JSON, and RPC modes
	// all finish Git finalization as part of the same run.
	pi.on("agent_end", async (_event, ctx: ExtensionContext) => {
		if (enforcementRunning) return;
		enforcementRunning = true;
		try {
			const result = await enforceRepository(manifest);
			if (result.kind === "ok") {
				repairTurns = 0;
				if (result.message && ctx.hasUI) ctx.ui.notify(result.message, "info");
				return;
			}
			if (result.kind === "blocked") {
				ctx.ui.setStatus("git-worktree-isolation", "worktree blocked");
				if (ctx.hasUI) ctx.ui.notify(result.message, "error");
				else process.stderr.write(`Pi worktree isolation: ${result.message}\n`);
				return;
			}
			if (repairTurns >= MAX_REPAIR_TURNS) {
				const message = "Git finalization failed after six automatic repair turns; the worktree was preserved.";
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				else process.stderr.write(`Pi worktree isolation: ${message}\n`);
				return;
			}
			repairTurns++;
			repairMessageActive = true;
			pi.sendMessage(
				{
					customType: CUSTOM_TYPE,
					content: `${result.prompt}\n\nThis is an automatic repository-finalization turn. Perform the Git work, verify the repository state, then reply exactly \`done\`.`,
					display: false,
				},
				{ triggerTurn: true },
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.setStatus("git-worktree-isolation", "worktree error");
			if (ctx.hasUI) ctx.ui.notify(`Git finalization failed: ${message}`, "error");
			else process.stderr.write(`Pi worktree isolation: ${message}\n`);
		} finally {
			enforcementRunning = false;
		}
	});

	pi.on("message_end", (event) => {
		if (!repairMessageActive) return;
		if (!event.message || typeof event.message !== "object" || (event.message as { role?: string }).role !== "assistant") return;
		repairMessageActive = false;
		if (!isBareDone(event.message)) return;
		return { message: { ...event.message, content: [{ type: "text", text: "" }] } };
	});

	pi.on("session_before_switch", async (event, ctx) => {
		// /new is sequential within one Pi process, so it safely reuses the
		// process's already-isolated worktree.
		if (event.reason === "new" || !event.targetSessionFile) return;
		const targetCwd = await sessionCwd(event.targetSessionFile);
		if (
			targetCwd &&
			(path.relative(manifest.worktreeRoot, targetCwd) === "" ||
				!path.relative(manifest.worktreeRoot, targetCwd).startsWith(".."))
		) {
			return;
		}
		const targetManifest = targetCwd ? await findManifestForCwd(targetCwd) : null;
		if (!targetCwd || !targetManifest || targetManifest.commonGitDir !== manifest.commonGitDir) {
			ctx.ui.notify("That session does not belong to a managed worktree for this repository.", "warning");
			return { cancel: true };
		}
		const finalized = await enforceRepository(manifest);
		if (finalized.kind !== "ok") {
			ctx.ui.notify("The current worktree could not be finalized safely, so resume was cancelled.", "warning");
			return { cancel: true };
		}
		resumeInManagedWorktree(event.targetSessionFile, targetCwd, targetManifest.manifestPath);
	});

	pi.on("session_before_fork", (_event, ctx) => {
		ctx.ui.notify("Exit Pi and fork from a new invocation so the fork receives its own worktree.", "warning");
		return { cancel: true };
	});
}

export default async function (pi: ExtensionAPI) {
	pi.registerFlag("no-worktree-isolation", {
		description: "Run without automatic Git worktree isolation",
		type: "boolean",
		default: false,
	});
	if (
		process.env[DISABLE_ENV] === "1" ||
		cliArgs().includes("--no-worktree-isolation") ||
		pi.getFlag("no-worktree-isolation") === true
	)
		return;
	if (process.env.PI_SUBAGENT_CHILD === "1" || isMetadataInvocation(cliArgs())) return;

	const cwd = await extensionCwd(pi);
	const explicitManifest = process.env[CHILD_MANIFEST_ENV];
	const manifest = explicitManifest ? await loadManifest(explicitManifest) : await findManifestForCwd(cwd);
	if (manifest) {
		const relative = path.relative(manifest.worktreeRoot, cwd);
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			fatal(`managed session cwd ${cwd} is outside ${manifest.worktreeRoot}.`);
		}
		registerManagedSession(pi, manifest);
		return;
	}

	try {
		// This extension is deployed from the live dotfiles checkout. That
		// repository explicitly forbids worktrees because setup can repoint live
		// symlinks into disposable paths.
		const extensionRepository = await findCommonGitDir(path.dirname(fileURLToPath(import.meta.url)));
		const currentRepository = await findCommonGitDir(cwd);
		if (!currentRepository) return;
		if (extensionRepository && currentRepository === extensionRepository) return;
	} catch (error) {
		fatal(error instanceof Error ? error.message : String(error));
	}

	if (isLegacyResumeInvocation(cliArgs())) {
		fatal("this saved session predates worktree isolation and cannot be relocated safely. Start a new session instead.");
	}
	try {
		const plan = await createLaunchPlan(cwd);
		if (cliArgs().some((arg) => arg === "--fork" || arg.startsWith("--fork="))) {
			// Pi creates a CLI fork before extensions load. Repoint that already-created
			// session at the managed cwd, then reopen it in the child instead of
			// replaying --fork and creating a duplicate session.
			pi.on("session_start", async (_event, ctx) => {
				try {
					const sessionFile = ctx.sessionManager.getSessionFile();
					if (!sessionFile) fatal("could not locate the newly created fork session.");
					await rewriteSessionCwd(sessionFile, plan.childCwd);
					relaunch(plan, forkChildArgs(sessionFile));
				} catch (error) {
					fatal(error instanceof Error ? error.message : String(error));
				}
			});
			return;
		}
		relaunch(plan);
	} catch (error) {
		fatal(error instanceof Error ? error.message : String(error));
	}
}
