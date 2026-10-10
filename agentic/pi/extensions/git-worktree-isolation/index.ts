/**
 * Enter a managed Git worktree only when an agent explicitly creates a branch.
 * Previously managed sessions remain resumable and retain their finalization policy.
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	acquireResumeClaim,
	acquireSessionLease,
	assertWorktreeReleasable,
	checkpointSessionIfPresent,
	checkpointWorktreeSessions,
	claimManagedWorktree,
	consumeResumeRecord,
	createLaunchPlan,
	createResumePlan,
	enforceRepository,
	findCommonGitDir,
	findManifestForCwd,
	hydrateIgnoredPaths,
	loadManifest,
	loadResumeRecord,
	reapStaleWorktrees,
	releaseManagedWorktree,
	prepareBranchCleanup,
	finishBranchCleanup,
	rewriteSessionCwd,
	sessionCwd,
	type SessionManifest,
} from "./git.ts";

const CHILD_MANIFEST_ENV = "PI_WORKTREE_SESSION_MANIFEST";
const BRANCH_CONTINUATION_ENV = "PI_WORKTREE_BRANCH_CONTINUATION";
const DISABLE_ENV = "PI_WORKTREE_ISOLATION_DISABLE";
const CUSTOM_TYPE = "git-worktree-isolation:finalize";
const RATE_LIMIT_RETRY_TYPE = "rate-limit-retry:continue";
const MAX_REPAIR_TURNS = 6;

/** Was this run resumed from a rate limit since the last genuine user message? */
export function recoveredFromRateLimit(ctx: ExtensionContext): boolean {
	for (const entry of ctx.sessionManager.getBranch().reverse()) {
		if (entry.type === "custom_message" && entry.customType === RATE_LIMIT_RETRY_TYPE) return true;
		if (entry.type === "message" && entry.message.role === "user") return false;
	}
	return false;
}

const SYSTEM_INSTRUCTION = `You are running in an isolated Git worktree managed by Pi.
Before concluding any turn that changes files, commit all intended changes and leave the worktree clean.
The feature branch is not merged automatically. Once its changes are on main, call clean-up-isolated-branch to return to main and remove the worktree and branch. If a PR or direct merge is needed, ask the user before merging; then retry the tool. Ignored outputs stay here; remove or save them before cleanup.
Older resumed sessions may be detached; Pi will publish those commits to the remembered branch.
Never bypass, remove, or alter the Pi worktree metadata.`;

function cliArgs(): string[] {
	return process.argv.slice(2);
}

export function isPrintMode(args = cliArgs()): boolean {
	return args.some((arg, index) =>
		arg === "--print" || arg === "-p" ||
		(arg === "--mode" && ["text", "json"].includes(args[index + 1] ?? "")) ||
		arg === "--mode=text" || arg === "--mode=json",
	);
}

function isMetadataInvocation(args: string[]): boolean {
	const command = args[0];
	if (["install", "remove", "uninstall", "update", "list", "config", "auth"].includes(command ?? "")) return true;
	return args.some((arg) => ["--help", "-h", "--version", "-v", "--list-models", "--export"].includes(arg));
}

function optionArgs(args: string[]): string[] {
	const end = args.indexOf("--");
	return end < 0 ? args : args.slice(0, end);
}

/** Keep launch constraints without replaying the old prompt or session selector. */
export function continuationArgs(sessionFile: string, prompt?: string, launchArgs = cliArgs()): string[] {
	const values = new Set([
		"--provider", "--model", "--api-key", "--system-prompt", "--append-system-prompt",
		"--mode", "--session-dir", "--models", "--tools", "-t", "--exclude-tools", "-xt",
		"--thinking", "--extension", "-e", "--skill", "--prompt-template", "--theme",
		"--use-theme", "--tui-mode", "--mcp-config",
	]);
	const flags = new Set([
		"--print", "-p", "--no-tools", "-nt", "--no-builtin-tools", "-nbt",
		"--no-mcp", "--no-skills", "-ns", "--no-prompt-templates", "-np",
		"--no-themes", "--no-context-files", "-nc", "--verbose",
		"--approve", "-a", "--no-approve", "-na", "--offline",
	]);
	const preserved: string[] = [];
	const args = optionArgs(launchArgs);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		const option = arg.split("=", 1)[0]!;
		if (flags.has(arg) || (values.has(option) && arg.includes("="))) preserved.push(arg);
		else if (values.has(arg) && i + 1 < args.length) preserved.push(arg, args[++i]!);
	}
	return ["--session", sessionFile, ...preserved, ...(prompt ? [prompt] : [])];
}

function isLegacyResumeInvocation(args: string[]): boolean {
	return optionArgs(args).some(
		(arg) =>
			["--continue", "-c", "--resume", "-r", "--session", "--session-id"].includes(arg) ||
			arg.startsWith("--session=") ||
			arg.startsWith("--session-id="),
	);
}

function isSessionIdInvocation(args: string[]): boolean {
	return optionArgs(args).some((arg) => arg === "--session-id" || arg.startsWith("--session-id="));
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

async function relaunch(plan: Awaited<ReturnType<typeof createLaunchPlan>>, args = cliArgs()): Promise<never> {
	const result = spawnSync(process.execPath, [process.argv[1]!, ...args], {
		cwd: plan.childCwd,
		stdio: "inherit",
		env: {
			...process.env,
			[CHILD_MANIFEST_ENV]: plan.manifest.manifestPath,
			[BRANCH_CONTINUATION_ENV]: "1",
		},
	});
	try {
		await reapStaleWorktrees(plan.manifest.repoRoot, result.pid || process.pid);
	} catch (error) {
		process.stderr.write(`Pi worktree isolation: recovery failed: ${error instanceof Error ? error.message : String(error)}\n`);
	}
	if (result.error) fatal(`could not relaunch Pi: ${result.error.message}`);
	process.exit(result.status ?? (result.signal === "SIGINT" ? 130 : 1));
}

async function resumeInManagedWorktree(sessionFile: string, cwd: string, manifestPath?: string): Promise<never> {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (manifestPath) env[CHILD_MANIFEST_ENV] = manifestPath;
	else delete env[CHILD_MANIFEST_ENV];
	const result = spawnSync(process.execPath, [process.argv[1]!, ...continuationArgs(sessionFile)], {
		cwd,
		stdio: "inherit",
		env,
	});
	const manifest = manifestPath ? await loadManifest(manifestPath).catch(() => null) : null;
	if (manifest) {
		try {
			await reapStaleWorktrees(manifest.repoRoot, result.pid || process.pid);
		} catch (error) {
			process.stderr.write(`Pi worktree isolation: recovery failed: ${error instanceof Error ? error.message : String(error)}\n`);
		}
	}
	if (result.error) fatal(`could not resume the selected worktree session: ${result.error.message}`);
	process.exit(result.status ?? (result.signal === "SIGINT" ? 130 : 1));
}

async function activateReleasedSession(sessionFile: string, expectedCommonGitDir?: string) {
	const releaseClaim = await acquireResumeClaim(sessionFile);
	try {
		const record = await loadResumeRecord(sessionFile);
		if (!record) throw new Error("The released-session record is no longer available.");
		if (expectedCommonGitDir && record.commonGitDir !== expectedCommonGitDir) {
			throw new Error("Session is not managed by this repository.");
		}
		const plan = await createResumePlan(record);
		await rewriteSessionCwd(record.sessionFile, plan.childCwd);
		await consumeResumeRecord(record);
		return plan;
	} finally {
		await releaseClaim();
	}
}

function registerReleasedSessionStartup(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) fatal("the selected saved session has no session file.");
		try {
			if (!await loadResumeRecord(sessionFile)) return;
			const plan = await activateReleasedSession(sessionFile);
			await reapStaleWorktrees(plan.manifest.repoRoot).catch((error) => {
				process.stderr.write(`Pi worktree isolation: recovery failed: ${error instanceof Error ? error.message : String(error)}\n`);
			});
			await resumeInManagedWorktree(sessionFile, plan.childCwd, plan.manifest.manifestPath);
		} catch (error) {
			fatal(error instanceof Error ? error.message : String(error));
		}
	});
}

const CLEANUP_UNAVAILABLE = "No eligible isolated feature branch is active. Run this from the worktree created by isolated_new_branch; older managed sessions without recorded branch ownership cannot safely delete a branch.";

function registerUnavailableCleanupTool(pi: ExtensionAPI): void {
	pi.registerCommand("clean-up-isolated-branch", {
		description: "Clean up the current isolated feature branch after its changes reach main",
		async handler(_args, ctx) { ctx.ui.notify(CLEANUP_UNAVAILABLE, "warning"); },
	});
	pi.registerTool({
		name: "clean-up-isolated-branch",
		label: "Clean up isolated branch",
		description: "Clean up an explicitly created isolated feature branch after its changes are on main. Requires running inside that managed branch; never merges a PR or branch automatically.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute() {
			throw new Error(CLEANUP_UNAVAILABLE);
		},
	});
}

function registerManagedSession(pi: ExtensionAPI, manifest: SessionManifest): void {
	let repairTurns = 0;
	let enforcementRunning = false;
	let pendingCleanup: { sessionFile: string; mainRoot: string; branchSha: string; branchExists: boolean } | null = null;
	let releaseSessionLease: (() => Promise<void>) | null = null;

	const releaseTranscript = async (): Promise<void> => {
		if (!releaseSessionLease) return;
		const release = releaseSessionLease;
		releaseSessionLease = null;
		await release();
	};

	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections["git-worktree-isolation"] = SYSTEM_INSTRUCTION;
	});

	pi.on("session_start", async (event, ctx) => {
		// Only the freshly relaunched child continues; reloads and later sessions do not.
		const continueBranch = event.reason === "startup" && process.env[BRANCH_CONTINUATION_ENV] === "1";
		delete process.env[BRANCH_CONTINUATION_ENV];
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) {
			try {
				releaseSessionLease = await acquireSessionLease(sessionFile);
			} catch (error) {
				fatal(error instanceof Error ? error.message : String(error));
			}
		}
		await hydrateIgnoredPaths(manifest);
		ctx.ui.setStatus("git-worktree-isolation", `🌳 ${manifest.id}`);
		if (continueBranch) {
			// Print mode returns as soon as session_start finishes unless we await the
			// extension-triggered turn. Register before starting it to avoid a race.
			const settled = isPrintMode() ? new Promise<void>((resolve) => {
				const unsubscribe = pi.on("agent_settled", () => { unsubscribe(); resolve(); });
			}) : undefined;
			pi.sendMessage({
				customType: "git-worktree-isolation:continue-branch",
				content: "Continue the previous request using the branch-creation result above.",
				display: false,
			}, { triggerTurn: true });
			if (settled) await settled;
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason !== "quit" || manifest.createdBranch) {
			await releaseTranscript();
			return;
		}
		try {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				process.stderr.write("Pi worktree isolation: session has no saved transcript; worktree was preserved.\n");
				return;
			}
			const finalized = await enforceRepository(manifest);
			if (finalized.kind !== "ok") {
				process.stderr.write("Pi worktree isolation: repository is not safely finalized; worktree was preserved.\n");
				return;
			}
			await assertWorktreeReleasable(manifest);
			await checkpointWorktreeSessions(manifest, sessionFile);
			process.chdir(manifest.repoRoot);
			await releaseManagedWorktree(manifest);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`Pi worktree isolation: could not release finalized worktree: ${message}\n`);
		} finally {
			await releaseTranscript();
		}
	});

	// AgentSession explicitly drains messages queued by agent_end handlers before
	// emitting agent_settled. Queue repair here so TUI, print, JSON, and RPC modes
	// all finish Git finalization as part of the same run.
	pi.on("agent_end", async (_event, ctx: ExtensionContext) => {
		if (enforcementRunning || pendingCleanup) return;
		enforcementRunning = true;
		try {
			const result = await enforceRepository(manifest);
			if (result.kind === "ok") {
				repairTurns = 0;
				// Git finalization must still run, but the benign contained-commit
				// notice is noise after quiet rate-limit recovery.
				if (
					result.message && ctx.hasUI &&
					!(result.message.includes("is already contained in") && recoveredFromRateLimit(ctx))
				) ctx.ui.notify(result.message, "info");
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
			pi.sendMessage(
				{
					customType: CUSTOM_TYPE,
					content: `${result.prompt}\n\nThis is an automatic repository-finalization turn, not a replacement for the user's request. Check whether the original request has unfinished work and complete it before wrapping up. Perform the Git work, verify the repository state, and give the user a brief, meaningful status update (including anything still incomplete). Do not reply with only \`done\`.`,
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

	const finishCleanup = async (
		sessionFile: string, mainRoot: string, branchSha: string, branchExists: boolean, clearStatus: () => void,
	): Promise<never> => {
		// Do not leave Pi's process cwd pointing into a worktree we remove.
		process.chdir(mainRoot);
		const mainCwd = await finishBranchCleanup(manifest, sessionFile, mainRoot, branchSha, branchExists);
		clearStatus();
		await releaseTranscript();
		return resumeInManagedWorktree(sessionFile, mainCwd);
	};
	pi.registerCommand("clean-up-isolated-branch", {
		description: "Return to main after verifying the isolated work is integrated",
		async handler(args, ctx) {
			if (args.trim()) {
				ctx.ui.notify("/clean-up-isolated-branch takes no arguments.", "warning");
				return;
			}
			if (!ctx.isIdle()) await ctx.waitForIdle();
			if (pendingCleanup) {
				ctx.ui.notify("Cleanup is already in progress.", "warning");
				return;
			}
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("A saved Pi session is required to clean up this branch.", "warning");
				return;
			}
			let prepared: Awaited<ReturnType<typeof prepareBranchCleanup>>;
			try {
				prepared = await prepareBranchCleanup(manifest);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
				else process.stderr.write(`Pi worktree isolation: ${message}\n`);
				return;
			}
			try {
				await finishCleanup(sessionFile, prepared.mainRoot, prepared.branchSha, prepared.branchExists,
					() => ctx.ui.setStatus("git-worktree-isolation", undefined));
			} catch (error) {
				fatal(`isolated branch cleanup stopped: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});
	pi.registerTool({
		name: "clean-up-isolated-branch",
		label: "Clean up isolated branch",
		description: "Return to main and remove this managed worktree after its changes are already on main. Deletes only a feature branch created by isolated_new_branch if it still exists. Fetches and safely fast-forwards main. Never merges a branch or PR automatically.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (pendingCleanup) throw new Error("Cleanup is already in progress.");
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("A saved Pi session is required to clean up this branch.");
			const { mainRoot, branchSha, branchExists } = await prepareBranchCleanup(manifest);
			pendingCleanup = { sessionFile, mainRoot, branchSha, branchExists };
			ctx.abort();
			return { content: [{ type: "text", text: `Verified this worktree's HEAD is on main. Cleaning up the isolated worktree and returning to main.` }], details: undefined };
		},
	});
	pi.on("agent_end", async (_event, ctx) => {
		if (!pendingCleanup) return;
		const { sessionFile, mainRoot, branchSha, branchExists } = pendingCleanup;
		pendingCleanup = null;
		try {
			await finishCleanup(sessionFile, mainRoot, branchSha, branchExists,
				() => ctx.ui.setStatus("git-worktree-isolation", undefined));
		} catch (error) {
			fatal(`isolated branch cleanup stopped: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	pi.on("session_before_switch", async (event, ctx) => {
		const finalized = await enforceRepository(manifest);
		if (finalized.kind !== "ok") {
			ctx.ui.notify("The current worktree could not be finalized safely, so the session switch was cancelled.", "warning");
			return { cancel: true };
		}
		const currentSessionFile = ctx.sessionManager.getSessionFile();
		if (!currentSessionFile) {
			ctx.ui.notify("The current session has no saved transcript, so it cannot be released safely.", "warning");
			return { cancel: true };
		}

		if (event.reason === "new") {
			try {
				if (!manifest.createdBranch) await checkpointSessionIfPresent(manifest, currentSessionFile);
				return;
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
				return { cancel: true };
			}
		}
		if (!event.targetSessionFile) return { cancel: true };

		const targetCwd = await sessionCwd(event.targetSessionFile);
		if (
			targetCwd &&
			(path.relative(manifest.worktreeRoot, targetCwd) === "" ||
				!path.relative(manifest.worktreeRoot, targetCwd).startsWith(".."))
		) {
			try {
				if (!manifest.createdBranch) await checkpointSessionIfPresent(manifest, currentSessionFile);
				return;
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
				return { cancel: true };
			}
		}

		let targetManifest = targetCwd ? await findManifestForCwd(targetCwd) : null;
		let resumedCwd = targetCwd;
		try {
			if (!targetManifest && await loadResumeRecord(event.targetSessionFile)) {
				const plan = await activateReleasedSession(event.targetSessionFile, manifest.commonGitDir);
				targetManifest = plan.manifest;
				resumedCwd = plan.childCwd;
			}
			if (!resumedCwd || (targetManifest && targetManifest.commonGitDir !== manifest.commonGitDir)) {
				throw new Error("The target session has no accessible checkout in this repository.");
			}
			await assertWorktreeReleasable(manifest);
			if (!manifest.createdBranch) await checkpointWorktreeSessions(manifest, currentSessionFile);
			process.chdir(manifest.repoRoot);
			if (!manifest.createdBranch) await releaseManagedWorktree(manifest);
			await releaseTranscript();
			await resumeInManagedWorktree(event.targetSessionFile, resumedCwd, targetManifest?.manifestPath);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			return { cancel: true };
		}
	});

	pi.on("session_before_fork", (_event, ctx) => {
		ctx.ui.notify("Exit Pi and fork from a new invocation so the fork receives its own worktree.", "warning");
		return { cancel: true };
	});
}

export default async function (pi: ExtensionAPI) {
	pi.registerFlag("no-worktree-isolation", {
		description: "Disable managed Git worktree sessions",
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
		await claimManagedWorktree(manifest);
		registerManagedSession(pi, manifest);
		return;
	}
	const resumeInvocation = isLegacyResumeInvocation(cliArgs());
	try {
		// This extension is deployed from the live dotfiles checkout. That
		// repository explicitly forbids worktrees because setup can repoint live
		// symlinks into disposable paths.
		const extensionRepository = await findCommonGitDir(path.dirname(fileURLToPath(import.meta.url)));
		const currentRepository = await findCommonGitDir(cwd);
		if (!currentRepository) {
			if (resumeInvocation) registerReleasedSessionStartup(pi);
			registerUnavailableCleanupTool(pi);
			return;
		}
		if (extensionRepository && currentRepository === extensionRepository) {
			registerUnavailableCleanupTool(pi);
			return;
		}
		if (resumeInvocation && !isSessionIdInvocation(cliArgs())) {
			registerReleasedSessionStartup(pi);
		}
	} catch (error) {
		fatal(error instanceof Error ? error.message : String(error));
	}

	registerUnavailableCleanupTool(pi);
	// A resumed ordinary session must not display a status left by a managed worktree.
	pi.on("session_start", (_event, ctx) => ctx.ui.setStatus("git-worktree-isolation", undefined));
	// Recovery no longer depends on launching a new worktree first.
	await reapStaleWorktrees(cwd).catch((error) => {
		process.stderr.write(`Pi worktree isolation: recovery failed: ${error instanceof Error ? error.message : String(error)}\n`);
	});
	pi.on("session_before_switch", async (event, ctx) => {
		if (!event.targetSessionFile) return;
		const record = await loadResumeRecord(event.targetSessionFile);
		if (!record || record.commonGitDir !== await findCommonGitDir(cwd)) return;
		try {
			const plan = await activateReleasedSession(event.targetSessionFile, record.commonGitDir);
			await resumeInManagedWorktree(event.targetSessionFile, plan.childCwd, plan.manifest.manifestPath);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			return { cancel: true };
		}
	});

	let pending: { plan: Awaited<ReturnType<typeof createLaunchPlan>>; sessionFile: string } | null = null;
	pi.registerTool({
		name: "isolated_new_branch",
		label: "Create isolated branch",
		description: "Create a named feature branch in an isolated worktree and continue this saved Pi session there. Requires a clean Git checkout; ignored configuration is linked as usual.",
		parameters: Type.Object({ name: Type.String({ description: "Name of the new feature branch" }) }),
		executionMode: "sequential",
		async execute(_toolCallId, { name }, _signal, _onUpdate, ctx) {
			if (pending) throw new Error("A branch transition is already in progress.");
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Save this Pi session before creating an isolated branch.");
			const plan = await createLaunchPlan(ctx.cwd, undefined, name);
			pending = { plan, sessionFile };
			ctx.abort();
			return { content: [{ type: "text", text: `Created ${name} at ${plan.childCwd}. Continuing this session there now; do not perform more work in the original checkout. Do not call isolated_new_branch again for this request.` }], details: undefined };
		},
		renderResult(result, { expanded }, theme, context) {
			const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
			if (expanded) return new Text(text, 0, 0);
			if (context.isError) return new Text(theme.fg("error", "✗ Could not create isolated branch"), 0, 0);
			return new Text(theme.fg("success", "✓ Isolated branch created"), 0, 0);
		},
	});
	pi.on("agent_end", async () => {
		if (!pending) return;
		const { plan, sessionFile } = pending;
		pending = null;
		try {
			await rewriteSessionCwd(sessionFile, plan.childCwd);
			await relaunch(plan, continuationArgs(sessionFile));
		} catch (error) {
			fatal(`could not enter the new branch; worktree remains at ${plan.childCwd}: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}
