import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Agent, type BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerIsolation, { continuationArgs, isPrintMode, launchWithProgress, recoveredFromRateLimit } from "./index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerLoop from "../loop/index.ts";
import { getLoopHandoff, isLoopActive, LOOP_HANDOFF_ENV } from "../_loop_state/state.ts";
import {
	acquirePublishLock,
	acquireResumeClaim,
	acquireSessionLease,
	checkpointSession,
	checkpointSessionIfPresent,
	checkpointWorktreeSessions,
	cleanLinkedIgnoredPaths,
	consumeResumeRecord,
	createLaunchPlan,
	createResumePlan,
	enforceRepository,
	findManifestForCwd,
	hydrateIgnoredPaths,
	loadResumeRecord,
	prepareBranchCleanup,
	prepareBranchDiscard,
	prepareBranchReturn,
	finishBranchCleanup,
	finishBranchDiscard,
	reapStaleWorktrees,
	releaseManagedWorktree,
	rewriteSessionCwd,
	saveManifest,
	sessionCwd,
	sessionDirectoryForCwd,
} from "./git.ts";

test("preserves output and prompt constraints when continuing in a branch", () => {
	assert.deepEqual(
		continuationArgs("/tmp/session.jsonl", "Continue", [
			"--print", "--mode=json", "--model", "provider/model", "--system-prompt", "Be careful",
			"--append-system-prompt=More rules", "--session-dir", "/tmp/sessions",
			"--fork", "old-session", "Old user request", "--", "ignored attachment",
		]),
		[
			"--session", "/tmp/session.jsonl", "--print", "--mode=json", "--model", "provider/model",
			"--system-prompt", "Be careful", "--append-system-prompt=More rules",
			"--session-dir", "/tmp/sessions", "Continue",
		],
	);
});

test("branch handoff preserves explicit-only extension loading across relaunches", () => {
	const initial = [
		"--system-prompt", "/tmp/main-prompt.md", "--no-extensions",
		"--extension", "/tmp/extensions/search", "-e", "/tmp/extensions/read",
		"--session", "/tmp/old.jsonl",
	];
	const expected = [
		"--session", "/tmp/session.jsonl", "--system-prompt", "/tmp/main-prompt.md",
		"--no-extensions", "--extension", "/tmp/extensions/search", "-e", "/tmp/extensions/read",
	];
	assert.deepEqual(continuationArgs("/tmp/session.jsonl", undefined, initial), expected);
	assert.deepEqual(continuationArgs("/tmp/session.jsonl", undefined, expected), expected);
	assert.deepEqual(continuationArgs("/tmp/session.jsonl", undefined, ["-ne", "-e", "/tmp/extensions/read"]), [
		"--session", "/tmp/session.jsonl", "-ne", "-e", "/tmp/extensions/read",
	]);
});

test("recognizes print-mode continuations without a fabricated prompt", () => {
	assert.equal(isPrintMode(["--print"]), true);
	assert.equal(isPrintMode(["-p", "--mode", "json"]), true);
	assert.equal(isPrintMode(["--mode=json"]), true);
	assert.equal(isPrintMode(["--mode", "text"]), true);
	assert.equal(isPrintMode(["--mode", "rpc"]), false);
	assert.equal(isPrintMode(["--session", "/tmp/session.jsonl"]), false);
});

test("branch handoff keeps the event loop running until the child takes over", async () => {
	const visibility: boolean[] = [];
	let ticks = 0;
	const interval = setInterval(() => { ticks++; }, 10);
	try {
		const result = await launchWithProgress(process.cwd(), ["-e", `
			setTimeout(() => {
				process.on('message', (message) => {
					if (message === 'pi-worktree-parent-yielded') process.disconnect();
				});
				process.send('pi-worktree-session-ready');
			}, 100);
			setTimeout(() => process.exit(0), 200);
		`], process.env, {
			mode: "tui", ui: {
				setWorkingVisible: (visible: boolean) => { visibility.push(visible); },
				setWidget: () => undefined,
			},
		} as ExtensionContext);
		assert.equal(result.status, 0);
		assert.ok(ticks >= 3, "the parent must remain responsive while the child starts");
		assert.deepEqual(visibility, [false], "the spinner yields only when the child is ready");
	} finally {
		clearInterval(interval);
	}
});

test("child working indicator is drawn after the parent yields the terminal", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-handoff-status-"));
	const trace = path.join(root, "trace");
	const extension = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
	const child = `
		const { appendFileSync } = await import('node:fs');
		const { createRequire } = await import('node:module');
		const require = createRequire(${JSON.stringify(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "_outliner", "package.json"))});
		const { createJiti } = require('jiti');
		const { signalChildReady } = await createJiti(import.meta.url).import(${JSON.stringify(extension)}, { default: false });
		await signalChildReady();
		appendFileSync(${JSON.stringify(trace)}, 'child-working\\n');
	`;
	try {
		const result = await launchWithProgress(process.cwd(), ["--input-type=module", "-e", child], process.env, {
			mode: "tui", ui: {
				setWorkingVisible: (visible: boolean) => {
					if (!visible) setTimeout(() => fs.appendFileSync(trace, "parent-cleared\n"), 16);
				},
				setWidget: () => undefined,
			},
		} as ExtensionContext);
		assert.equal(result.status, 0);
		assert.deepEqual(fs.readFileSync(trace, "utf8").trim().split("\n"), ["parent-cleared", "child-working"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("detects a rate-limit retry only in the current user request", () => {
	const entries = [
		{ type: "custom_message", customType: "rate-limit-retry:continue" },
		{ type: "message", message: { role: "assistant" } },
	];
	const ctx = { sessionManager: { getBranch: () => [...entries] } } as unknown as ExtensionContext;
	assert.equal(recoveredFromRateLimit(ctx), true);
	entries.push({ type: "message", message: { role: "user" } });
	assert.equal(recoveredFromRateLimit(ctx), false);
});

type BranchRenderResult = (
	result: { content: Array<{ type: "text"; text: string }> },
	options: { expanded: boolean; isPartial: boolean },
	theme: { fg: (color: string, text: string) => string },
	context: { isError: boolean },
) => { render: (width: number) => string[] };
type BranchRenderCall = (
	args: { name?: string },
	theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
) => { render: (width: number) => string[] };

const temporaryRoots: string[] = [];

function command(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepo(): { root: string; agentDir: string } {
	const container = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-test-"));
	temporaryRoots.push(container);
	const root = path.join(container, "repo");
	const agentDir = path.join(container, "agent");
	fs.mkdirSync(root);
	command(root, ["init", "-b", "main"]);
	command(root, ["config", "user.email", "pi@example.invalid"]);
	command(root, ["config", "user.name", "Pi Test"]);
	fs.writeFileSync(path.join(root, "base.txt"), "base\n");
	command(root, ["add", "."]);
	command(root, ["commit", "-m", "chore: initial"]);
	return { root, agentDir };
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("returning to main preserves an unmerged PR branch and refuses dirty checkouts", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), "dist/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore build output"]);
	const plan = await createLaunchPlan(root, agentDir, "feat/issue-one");
	fs.mkdirSync(path.join(plan.manifest.worktreeRoot, "dist"));
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "dist", "bundle.js"), "built");
	assert.equal(await prepareBranchReturn(plan.manifest), await fs.promises.realpath(root));
	assert.equal(command(plan.manifest.worktreeRoot, ["branch", "--show-current"]), "feat/issue-one");
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "uncommitted.txt"), "work");
	await assert.rejects(prepareBranchReturn(plan.manifest), /not clean/);
	fs.unlinkSync(path.join(plan.manifest.worktreeRoot, "uncommitted.txt"));
	fs.writeFileSync(path.join(root, "uncommitted.txt"), "work");
	await assert.rejects(prepareBranchReturn(plan.manifest), /main checkout has uncommitted changes/);
	fs.unlinkSync(path.join(root, "uncommitted.txt"));
	assert.equal(command(root, ["show-ref", "--verify", "refs/heads/feat/issue-one"]).split(" ")[1], "refs/heads/feat/issue-one");
});

test("creates a detached worktree without creating a branch", async () => {
	const { root, agentDir } = createRepo();
	const nested = path.join(root, "nested");
	fs.mkdirSync(nested);
	const plan = await createLaunchPlan(nested, agentDir);

	assert.throws(() => command(plan.manifest.worktreeRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
	assert.match(plan.manifest.id, /^[a-z]+-[a-z]+(?:-\d{4})?$/);
	assert.equal(command(root, ["branch", "--format=%(refname:short)"]), "main");
	assert.equal(plan.childCwd, path.join(plan.manifest.worktreeRoot, "nested"));
	assert.deepEqual((await findManifestForCwd(plan.childCwd))?.id, plan.manifest.id);
	const hub = fs.realpathSync(sessionDirectoryForCwd(root, agentDir));
	assert.equal(fs.realpathSync(sessionDirectoryForCwd(nested, agentDir)), hub);
	assert.equal(fs.realpathSync(sessionDirectoryForCwd(plan.childCwd, agentDir)), hub);
});

test("registers an opt-in branch tool without isolating ordinary sessions", async () => {
	const { root, agentDir } = createRepo();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const tools = new Map<string, {
			execute: (...args: unknown[]) => Promise<unknown>;
			renderCall?: BranchRenderCall;
			renderResult?: BranchRenderResult;
		}>();
		const commands: string[] = [];
		const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
		const pi = {
			registerFlag: () => undefined,
			registerCommand: (name: string) => { commands.push(name); },
			getFlag: () => false,
			exec: async () => ({ code: 0, stdout: `${root}\n` }),
			registerTool: (registered: { name: string; execute: (...args: unknown[]) => Promise<unknown>; renderCall?: BranchRenderCall; renderResult?: BranchRenderResult }) => {
				tools.set(registered.name, registered);
			},
			on: (name: string, handler: (...args: unknown[]) => unknown) => {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
		} as unknown as ExtensionAPI;
		await registerIsolation(pi);
		const statuses: Array<[string, string | undefined]> = [];
		for (const handler of handlers.get("session_start") ?? []) {
			await handler({}, { ui: { setStatus: (key: string, text: string | undefined) => { statuses.push([key, text]); } } });
		}
		assert.deepEqual(statuses, [["git-worktree-isolation", undefined]]);
		assert.ok(tools.has("isolated_new_branch"));
		assert.ok(tools.has("discard_isolated_branch"));
		await assert.rejects(tools.get("discard_isolated_branch")!.execute(), /No eligible isolated feature branch/);
		assert.ok(tools.has("clean_up_isolated_branch"));
		assert.ok(commands.includes("clean_up_isolated_branch"));
		await assert.rejects(tools.get("clean_up_isolated_branch")!.execute(), /No eligible isolated feature branch/);
		tools.clear();
		const originalArgv = process.argv;
		try {
			process.argv = ["node", "pi", "--session", path.join(agentDir, "session.jsonl")];
			await registerIsolation(pi);
			assert.ok(tools.has("isolated_new_branch"), "resuming an ordinary session must retain the branch tool");
			assert.ok(tools.has("clean_up_isolated_branch"));
		} finally {
			process.argv = originalArgv;
		}
		assert.deepEqual(command(root, ["worktree", "list", "--porcelain"]).match(/^worktree /gm), ["worktree "]);
		const branchGuard = handlers.get("tool_call")?.at(-1);
		assert.equal(branchGuard?.(), undefined);
		let aborted = false;
		const result = await tools.get("isolated_new_branch")!.execute("call", { name: "feat/from-tool" }, undefined, undefined, {
			cwd: root,
			sessionManager: { getSessionFile: () => path.join(agentDir, "session.jsonl") },
			abort: () => { aborted = true; },
		});
		assert.equal(aborted, false, "branch handoff must not abort the agent run");
		assert.deepEqual(branchGuard?.(), {
			block: true, reason: "Branch transition is already in progress.", terminate: true,
		});
		assert.ok(handlers.get("turn_end")?.length, "handoff waits until the tool result is persisted");
		assert.match(JSON.stringify(result), /feat\/from-tool/);
		assert.match(JSON.stringify(result), /Do not call isolated_new_branch again/);
		const render = tools.get("isolated_new_branch")!.renderResult!;
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const output = result as { content: Array<{ type: "text"; text: string }> };
		assert.equal(tools.get("isolated_new_branch")!.renderCall!({ name: "feat/from-tool" }, theme).render(100).join("").trimEnd(), "isolated_new_branch feat/from-tool");
		assert.equal(render(output, { expanded: false, isPartial: true }, theme, { isError: false }).render(100).join("").trimEnd(), "⋯ creating branch");
		assert.equal(render(output, { expanded: false, isPartial: false }, theme, { isError: false }).render(100).join("").trimEnd(), "✓ switched to new branch");
		assert.match(render(output, { expanded: true, isPartial: false }, theme, { isError: false }).render(200).join(""), /Created feat\/from-tool at/);
		const failed = { content: [{ type: "text" as const, text: "Cannot create branch: checkout is dirty" }] };
		assert.match(render(failed, { expanded: false, isPartial: false }, theme, { isError: true }).render(100).join(""), /checkout is dirty/);
		assert.equal(command(root, ["branch", "--show-current"]), "main");
		assert.equal(command(root, ["branch", "--list", "feat/from-tool"]), "+ feat/from-tool");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("branch continuation restores Pi's existing working indicator", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir, "feat/visible-continuation");
	const sessionFile = path.join(agentDir, "continuation.jsonl");
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", cwd: plan.childCwd })}\n`);
	const previousManifest = process.env.PI_WORKTREE_SESSION_MANIFEST;
	const previousContinuation = process.env.PI_WORKTREE_BRANCH_CONTINUATION;
	process.env.PI_WORKTREE_SESSION_MANIFEST = plan.manifest.manifestPath;
	process.env.PI_WORKTREE_BRANCH_CONTINUATION = "1";
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const widgets: string[] = [];
	let sent = false;
	let streaming = false;
	let builtinSpinner = false;
	let ctx: ExtensionContext;
	try {
		await registerIsolation({
			registerFlag: () => undefined,
			registerCommand: () => undefined,
			getFlag: () => false,
			exec: async () => ({ code: 0, stdout: `${plan.childCwd}\n` }),
			registerTool: () => undefined,
			on: (name: string, handler: (...args: unknown[]) => unknown) => {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
				return () => undefined;
			},
			sendMessage: () => {
				sent = true;
				streaming = true;
				for (const start of handlers.get("agent_start") ?? []) start({}, ctx);
				assert.equal(builtinSpinner, true, "Pi's original working indicator must be visible during the run");
				assert.deepEqual(widgets, [], "the handoff must not add a separate spinner widget");
			},
		} as unknown as ExtensionAPI);
		ctx = {
			mode: "tui", sessionManager: { getSessionFile: () => sessionFile },
			ui: {
				setStatus: () => undefined,
				setWidget: (key: string) => { widgets.push(key); },
				setWorkingVisible: (visible: boolean) => { builtinSpinner = visible && streaming; },
			},
		} as unknown as ExtensionContext;
		for (const start of handlers.get("session_start") ?? []) await start({ reason: "startup" }, ctx);
		assert.equal(sent, true);
		streaming = false;
		for (const settled of handlers.get("agent_settled") ?? []) await settled({}, ctx);
		assert.equal(builtinSpinner, false, "a fast child must not leave the built-in indicator running");
		assert.deepEqual(widgets, []);
		for (const shutdown of handlers.get("session_shutdown") ?? []) await shutdown({ reason: "reload" }, ctx);
	} finally {
		if (previousManifest === undefined) delete process.env.PI_WORKTREE_SESSION_MANIFEST;
		else process.env.PI_WORKTREE_SESSION_MANIFEST = previousManifest;
		if (previousContinuation === undefined) delete process.env.PI_WORKTREE_BRANCH_CONTINUATION;
		else process.env.PI_WORKTREE_BRANCH_CONTINUATION = previousContinuation;
	}
});

test("cleanup relaunch requests one final completion message on main", async () => {
	const { root } = createRepo();
	const previous = process.env.PI_WORKTREE_CLEANUP_CONTINUATION;
	process.env.PI_WORKTREE_CLEANUP_CONTINUATION = "1";
	try {
		const starts: Array<(_event: unknown, ctx: unknown) => Promise<void>> = [];
		const messages: Array<{ content: string; display: boolean }> = [];
		await registerIsolation({
			registerFlag: () => undefined,
			registerCommand: () => undefined,
			getFlag: () => false,
			exec: async () => ({ code: 0, stdout: `${root}\n` }),
			registerTool: () => undefined,
			on: (name: string, handler: () => Promise<void>) => {
				if (name === "session_start") starts.push(handler);
				return () => undefined;
			},
			sendMessage: (message: { content: string; display: boolean }) => { messages.push(message); },
		} as unknown as ExtensionAPI);
		assert.equal(process.env.PI_WORKTREE_CLEANUP_CONTINUATION, undefined);
		for (const start of starts) await start({}, { ui: { setStatus: () => undefined } });
		assert.equal(messages.length, 1);
		assert.match(messages[0]!.content, /brief completion message/);
		assert.equal(messages[0]!.display, false);
		for (const start of starts) await start({}, { ui: { setStatus: () => undefined } });
		assert.equal(messages.length, 1, "session changes must not repeat the completion turn");
	} finally {
		if (previous === undefined) delete process.env.PI_WORKTREE_CLEANUP_CONTINUATION;
		else process.env.PI_WORKTREE_CLEANUP_CONTINUATION = previous;
	}
});

for (const transition of ["branch", "cleanup"] as const) {
	for (const loopFirst of [false, true]) {
		test(`${transition} continuation preserves the current loop iteration (${loopFirst ? "loop" : "Git"} starts first)`, async () => {
			const { root, agentDir } = createRepo();
			const plan = transition === "branch" ? await createLaunchPlan(root, agentDir, "feat/loop-continuation") : undefined;
			const cwd = plan?.childCwd ?? root;
			const sessionFile = path.join(root, "session.jsonl");
			fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", cwd })}\n`);
			const keys = [LOOP_HANDOFF_ENV, "PI_WORKTREE_SESSION_MANIFEST", "PI_WORKTREE_BRANCH_CONTINUATION", "PI_WORKTREE_CLEANUP_CONTINUATION"];
			const previous = keys.map((key) => process.env[key]);
			const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
			const ctx = {
				mode: "rpc", cwd,
				sessionManager: { getSessionId: () => "loop-continuation-fixture", getSessionFile: () => sessionFile },
				ui: { setStatus: () => undefined },
				isIdle: () => true, hasPendingMessages: () => false,
			} as unknown as ExtensionContext;
			const emit = async (name: string, event: unknown) => {
				for (const handler of [...(handlers.get(name) ?? [])]) await handler(event, ctx);
			};
			let checks = 0;
			let continuations = 0;
			const pi = {
				registerFlag: () => undefined, registerCommand: () => undefined, registerTool: () => undefined,
				getFlag: () => false,
				exec: async () => ({ code: 0, stdout: `${cwd}\n` }),
				on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
					handlers.set(name, [...(handlers.get(name) ?? []), handler]);
					return () => undefined;
				},
				sendUserMessage: () => assert.fail("a handoff must not start a new iteration"),
				sendMessage: (message: { content: string }, options?: { triggerTurn?: boolean }) => {
					if (!options?.triggerTurn) return;
					continuations++;
					assert.equal(isLoopActive(), true, "restore the loop before starting the continuation");
					assert.equal(getLoopHandoff(sessionFile)?.runs, 1);
					assert.equal(checks, 0, "switching checkouts must not evaluate completion");
					assert.match(message.content, /Continue the previous request/);
					assert.doesNotMatch(message.content, /Give the user a brief completion message about the finished request/);
				},
			} as unknown as ExtensionAPI;
			const loadLoop = () => registerLoop(pi, { check: async () => {
				checks++;
				return { done: true, evidence: "remaining work finished" };
			} });
			try {
				process.env[LOOP_HANDOFF_ENV] = JSON.stringify({
					sessionFile, prompt: "finish the work", intervalMs: 0, runs: 1, maxRuns: 1,
					condition: "work finished", phase: "running", returnToBase: false,
				});
				if (plan) process.env.PI_WORKTREE_SESSION_MANIFEST = plan.manifest.manifestPath;
				else delete process.env.PI_WORKTREE_SESSION_MANIFEST;
				process.env[transition === "branch" ? "PI_WORKTREE_BRANCH_CONTINUATION" : "PI_WORKTREE_CLEANUP_CONTINUATION"] = "1";
				if (loopFirst) loadLoop();
				await registerIsolation(pi);
				if (!loopFirst) loadLoop();
				await emit("session_start", { reason: "startup" });
				assert.equal(continuations, 1);
				assert.equal(isLoopActive(), true, "later startup handlers must not reset the restored loop");
				assert.equal(getLoopHandoff(sessionFile)?.runs, 1);
				assert.equal(checks, 0);
				await emit("agent_start", {});
				await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "work finished" }] }] });
				await emit("agent_settled", {});
				assert.equal(checks, 1, "only the finished request evaluates completion");
				assert.equal(isLoopActive(), false);
			} finally {
				await emit("session_shutdown", { reason: "reload" });
				keys.forEach((key, index) => {
					if (previous[index] === undefined) delete process.env[key];
					else process.env[key] = previous[index];
				});
			}
		});
	}
}

test("cleanup tool is discoverable in the exempt dotfiles checkout", async () => {
	const cwd = command(path.dirname(fileURLToPath(import.meta.url)), ["rev-parse", "--show-toplevel"]);
	const tools: Array<{ name: string; renderCall: BranchRenderCall; renderResult: BranchRenderResult }> = [];
	const commands: string[] = [];
	const pi = {
		registerFlag: () => undefined,
		registerCommand: (name: string) => { commands.push(name); },
		getFlag: () => false,
		exec: async () => ({ code: 0, stdout: `${cwd}\n` }),
		registerTool: (tool: { name: string; renderCall: BranchRenderCall; renderResult: BranchRenderResult }) => { tools.push(tool); },
		on: () => undefined,
	} as unknown as ExtensionAPI;
	await registerIsolation(pi);
	assert.deepEqual(tools.map((tool) => tool.name), ["discard_isolated_branch", "clean_up_isolated_branch"]);
	assert.deepEqual(commands, ["clean_up_isolated_branch"]);
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	assert.equal(tools[0]!.renderCall({}, theme).render(100).join("").trimEnd(), "discard_isolated_branch");
	assert.equal(tools[1]!.renderCall({}, theme).render(100).join("").trimEnd(), "clean_up_isolated_branch");
	assert.equal(tools[1]!.renderResult({ content: [] }, { expanded: false, isPartial: true }, theme, { isError: false }).render(100).join("").trimEnd(), "⋯ cleaning up branch");
});

test("ordinary startup reaps a clean abandoned managed worktree", async () => {
	const { root, agentDir } = createRepo();
	const stale = await createLaunchPlan(root, agentDir);
	stale.manifest.ownerPid = 99999999;
	await saveManifest(stale.manifest);
	const pi = {
		registerFlag: () => undefined,
		registerCommand: () => undefined,
		getFlag: () => false,
		exec: async () => ({ code: 0, stdout: `${root}\n` }),
		registerTool: () => undefined,
		on: () => undefined,
	} as unknown as ExtensionAPI;
	await registerIsolation(pi);
	assert.equal(fs.existsSync(stale.manifest.worktreeRoot), false);
	assert.equal(command(root, ["branch", "--show-current"]), "main");
});

test("launches a detached checkout on its own publication branch", async () => {
	const { root, agentDir } = createRepo();
	command(root, ["checkout", "--detach"]);
	const plan = await createLaunchPlan(root, agentDir);
	assert.equal(plan.manifest.targetBranch, `pi/${plan.manifest.id}`);
	assert.equal(command(root, ["rev-parse", plan.manifest.targetRef]), command(plan.childCwd, ["rev-parse", "HEAD"]));
	fs.writeFileSync(path.join(plan.childCwd, "new.txt"), "new\n");
	command(plan.childCwd, ["add", "new.txt"]);
	command(plan.childCwd, ["commit", "-m", "feat: detached work"]);
	assert.equal((await enforceRepository(plan.manifest)).kind, "ok");
	assert.equal(command(root, ["rev-parse", plan.manifest.targetRef]), command(plan.childCwd, ["rev-parse", "HEAD"]));
	await releaseManagedWorktree(plan.manifest);
	assert.equal(command(root, ["rev-parse", "--abbrev-ref", "HEAD"]), "HEAD");
});

test("links ignored files, nested paths, and directories without exposing them to Git", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), ".env*\nignored.txt\nassets/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore local files"]);
	fs.writeFileSync(path.join(root, ".env"), "ROOT_SECRET=root\n");
	fs.writeFileSync(path.join(root, ".env.local"), "LOCAL_SECRET=local\n");
	const nested = path.join(root, "service");
	fs.mkdirSync(nested);
	fs.writeFileSync(path.join(nested, ".env.local"), "SERVICE_SECRET=service\n");
	fs.symlinkSync(".env", path.join(root, ".env.link"));
	fs.writeFileSync(path.join(root, "ignored.txt"), "ignored\n");
	fs.mkdirSync(path.join(root, "assets"));
	fs.writeFileSync(path.join(root, "assets", "data"), "cached\n");

	const plan = await createLaunchPlan(root, agentDir);
	const target = (relativePath: string) => path.join(plan.manifest.worktreeRoot, relativePath);
	assert.deepEqual(plan.manifest.linkedIgnoredPaths, [".env", ".env.link", ".env.local", "assets", "ignored.txt", "service/.env.local"]);
	for (const relativePath of plan.manifest.linkedIgnoredPaths ?? []) {
		assert.equal(fs.readlinkSync(target(relativePath)), path.join(fs.realpathSync(root), relativePath));
	}
	assert.equal(fs.readFileSync(target("assets/data"), "utf8"), "cached\n");
	assert.equal(fs.readlinkSync(target(".env.link")), path.join(fs.realpathSync(root), ".env.link"));
	assert.equal(command(plan.manifest.worktreeRoot, ["status", "--porcelain"]), "");
	fs.writeFileSync(target("assets/data"), "edited\n");
	assert.equal(fs.readFileSync(path.join(root, "assets/data"), "utf8"), "edited\n");

	await cleanLinkedIgnoredPaths(plan.manifest);
	assert.equal(fs.existsSync(target("assets")), false);
	assert.equal(fs.readFileSync(path.join(root, "assets/data"), "utf8"), "edited\n");
	await hydrateIgnoredPaths(plan.manifest);
	assert.equal(fs.readFileSync(target("assets/data"), "utf8"), "edited\n");
	assert.equal(command(plan.manifest.worktreeRoot, ["status", "--porcelain"]), "");
});

test("does not link dependency and cache directories into new worktrees", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), ".env\n.venv/\nnode_modules*/\n.pytest_cache/\nservice/__pycache__/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore build outputs"]);
	fs.writeFileSync(path.join(root, ".env"), "CONFIG=yes\n");
	for (const name of [".venv", "node_modules", "node_modules-brave-rabbit", ".pytest_cache", "service/__pycache__"]) {
		fs.mkdirSync(path.join(root, name), { recursive: true });
		fs.writeFileSync(path.join(root, name, "artifact"), "generated\n");
	}
	const plan = await createLaunchPlan(root, agentDir);
	assert.equal(fs.readlinkSync(path.join(plan.childCwd, ".env")), path.join(fs.realpathSync(root), ".env"));
	for (const name of [".venv", "node_modules", "node_modules-brave-rabbit", ".pytest_cache", "service/__pycache__"]) {
		assert.equal(fs.existsSync(path.join(plan.childCwd, name)), false, `${name} must not be inherited`);
	}
	for (const name of [".venv", "node_modules", "node_modules-brave-rabbit"]) {
		fs.mkdirSync(path.join(plan.childCwd, name));
		fs.writeFileSync(path.join(plan.childCwd, name, "new"), "session\n");
	}
	await releaseManagedWorktree(plan.manifest);
	assert.equal(fs.existsSync(plan.childCwd), false);
	for (const name of [".venv", "node_modules", "node_modules-brave-rabbit"]) {
		assert.equal(fs.readFileSync(path.join(root, name, "artifact"), "utf8"), "generated\n");
	}
	const next = await createLaunchPlan(root, agentDir);
	assert.equal(fs.existsSync(path.join(next.childCwd, `.venv-${plan.manifest.id}`)), false);
});

test("releases and resumes linked ignored directories without deleting their contents", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), "assets/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore assets"]);
	fs.mkdirSync(path.join(root, "assets"));
	fs.writeFileSync(path.join(root, "assets", "result"), "keep\n");
	const plan = await createLaunchPlan(root, agentDir);
	assert.equal(command(plan.childCwd, ["status", "--porcelain"]), "");
	const sessionFile = path.join(agentDir, "resume.jsonl");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "resume", cwd: plan.childCwd })}\n`);
	const record = await checkpointSession(plan.manifest, sessionFile);
	await releaseManagedWorktree(plan.manifest);
	assert.equal(fs.readFileSync(path.join(root, "assets/result"), "utf8"), "keep\n");
	const resumed = await createResumePlan(record);
	assert.equal(fs.readlinkSync(path.join(resumed.childCwd, "assets")), path.join(fs.realpathSync(root), "assets"));
	assert.equal(command(resumed.childCwd, ["status", "--porcelain"]), "");
});

test("keeps ignored coverage local and discards generated coverage on release", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), ".coverage\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore coverage"]);
	fs.writeFileSync(path.join(root, ".coverage"), "original\n");
	const plan = await createLaunchPlan(root, agentDir);
	const coverage = path.join(plan.childCwd, ".coverage");
	assert.equal(plan.manifest.linkedIgnoredPaths?.includes(".coverage"), false);
	assert.equal(fs.existsSync(coverage), false);
	fs.writeFileSync(coverage, "generated\n");
	assert.equal(fs.readFileSync(path.join(root, ".coverage"), "utf8"), "original\n");
	await releaseManagedWorktree(plan.manifest);
	assert.equal(fs.readFileSync(path.join(root, ".coverage"), "utf8"), "original\n");
	assert.equal(fs.existsSync(plan.manifest.worktreeRoot), false);
});

test("removes generated cache directories on release without touching original checkout caches", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), "cache/\n.pytest_cache/\n.mypy_cache/\n__pycache__/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore caches"]);
	fs.mkdirSync(path.join(root, ".pytest_cache"));
	fs.writeFileSync(path.join(root, ".pytest_cache/original"), "keep\n");
	const plan = await createLaunchPlan(root, agentDir);
	for (const relativePath of ["cache", ".pytest_cache", ".mypy_cache", "nested/__pycache__"]) {
		const directory = path.join(plan.childCwd, relativePath);
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, "generated"), "discard\n");
	}
	assert.equal(plan.manifest.linkedIgnoredPaths?.includes(".pytest_cache"), false);
	await releaseManagedWorktree(plan.manifest);
	assert.equal(fs.existsSync(plan.childCwd), false);
	assert.equal(fs.readFileSync(path.join(root, ".pytest_cache/original"), "utf8"), "keep\n");
});

test("removes local venv directories but preserves files and symlinks at those paths", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), ".venv\nvenv\nnode_modules\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore virtual environments"]);
	const plan = await createLaunchPlan(root, agentDir);
	fs.mkdirSync(path.join(plan.childCwd, ".venv"));
	fs.mkdirSync(path.join(plan.childCwd, "venv"));
	fs.writeFileSync(path.join(plan.childCwd, ".venv", "artifact"), "generated\n");
	await releaseManagedWorktree(plan.manifest);
	assert.equal(fs.existsSync(plan.childCwd), false);
	const filePlan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(filePlan.childCwd, "venv"), "keep\n");
	await assert.rejects(releaseManagedWorktree(filePlan.manifest), /Ignored path venv/);
	const linkPlan = await createLaunchPlan(root, agentDir);
	fs.mkdirSync(path.join(root, ".venv"));
	fs.writeFileSync(path.join(root, ".venv/original"), "keep\n");
	fs.symlinkSync(path.join(root, ".venv"), path.join(linkPlan.childCwd, ".venv"));
	await assert.rejects(releaseManagedWorktree(linkPlan.manifest), /Ignored path .venv/);
	assert.equal(fs.readFileSync(path.join(root, ".venv/original"), "utf8"), "keep\n");
	const modulesPlan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(modulesPlan.childCwd, "node_modules"), "keep\n");
	await assert.rejects(releaseManagedWorktree(modulesPlan.manifest), /Ignored path node_modules/);
});

test("refuses ignored cache-named files and symlinks", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), "cache\n.pytest_cache\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore caches"]);
	const filePlan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(filePlan.childCwd, "cache"), "keep\n");
	await assert.rejects(releaseManagedWorktree(filePlan.manifest), /Ignored path cache/);
	assert.equal(fs.readFileSync(path.join(filePlan.childCwd, "cache"), "utf8"), "keep\n");
	const linkPlan = await createLaunchPlan(root, agentDir);
	fs.mkdirSync(path.join(root, ".pytest_cache"));
	fs.writeFileSync(path.join(root, ".pytest_cache/original"), "keep\n");
	fs.symlinkSync(path.join(root, ".pytest_cache"), path.join(linkPlan.childCwd, ".pytest_cache"));
	await assert.rejects(releaseManagedWorktree(linkPlan.manifest), /Ignored path .pytest_cache/);
	assert.equal(fs.readFileSync(path.join(root, ".pytest_cache/original"), "utf8"), "keep\n");
});

test("discards replaced coverage links from older sessions", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), ".coverage\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore coverage"]);
	fs.writeFileSync(path.join(root, ".coverage"), "original\n");
	const plan = await createLaunchPlan(root, agentDir);
	const coverage = path.join(plan.childCwd, ".coverage");
	fs.symlinkSync(path.join(root, ".coverage"), coverage);
	plan.manifest.linkedIgnoredPaths?.push(".coverage");
	await saveManifest(plan.manifest);
	fs.unlinkSync(coverage);
	fs.writeFileSync(coverage, "generated\n");
	await releaseManagedWorktree(plan.manifest);
	assert.equal(fs.readFileSync(path.join(root, ".coverage"), "utf8"), "original\n");
	assert.equal(fs.existsSync(plan.manifest.worktreeRoot), false);
});

test("moves a replaced ignored link without deleting session data", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), "assets/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore assets"]);
	fs.mkdirSync(path.join(root, "assets"));
	fs.writeFileSync(path.join(root, "assets", "old"), "original\n");
	const plan = await createLaunchPlan(root, agentDir);
	fs.unlinkSync(path.join(plan.childCwd, "assets"));
	fs.mkdirSync(path.join(plan.childCwd, "assets"));
	fs.writeFileSync(path.join(plan.childCwd, "assets", "important"), "keep\n");
	await assert.rejects(releaseManagedWorktree(plan.manifest), /Linked ignored path assets was replaced/);
	assert.equal(fs.readFileSync(path.join(plan.childCwd, "assets/important"), "utf8"), "keep\n");
});

test("resumes with a locally replaced ignored directory without allowing cleanup", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), "apps/desktop/out/\nassets/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore outputs"]);
	fs.mkdirSync(path.join(root, "apps/desktop/out"), { recursive: true });
	fs.writeFileSync(path.join(root, "apps/desktop/out/original"), "root\n");
	fs.mkdirSync(path.join(root, "assets"));
	fs.writeFileSync(path.join(root, "assets/data"), "shared\n");
	const plan = await createLaunchPlan(root, agentDir);
	const localOutput = path.join(plan.childCwd, "apps/desktop/out");
	fs.unlinkSync(localOutput);
	fs.mkdirSync(localOutput);
	fs.writeFileSync(path.join(localOutput, "local"), "session\n");

	await hydrateIgnoredPaths(plan.manifest);
	await hydrateIgnoredPaths(plan.manifest);
	assert.equal(fs.readFileSync(path.join(localOutput, "local"), "utf8"), "session\n");
	assert.equal(fs.readFileSync(path.join(root, "apps/desktop/out/original"), "utf8"), "root\n");
	assert.equal(fs.readlinkSync(path.join(plan.childCwd, "assets")), path.join(fs.realpathSync(root), "assets"));
	assert.ok(plan.manifest.linkedIgnoredPaths?.includes("apps/desktop/out"));
	const saved = await findManifestForCwd(plan.childCwd);
	assert.ok(saved?.linkedIgnoredPaths?.includes("apps/desktop/out"));
	await assert.rejects(releaseManagedWorktree(saved!), /Linked ignored path apps\/desktop\/out was replaced/);
	assert.equal(fs.readFileSync(path.join(localOutput, "local"), "utf8"), "session\n");
});

test("does not treat a tracked directory on a new branch as a replaced ignored link", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), "data/experiments/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore data"]);
	fs.mkdirSync(path.join(root, "data/experiments"), { recursive: true });
	fs.writeFileSync(path.join(root, "data/experiments/old.log"), "ignored\n");
	const plan = await createLaunchPlan(root, agentDir);
	assert.ok(plan.manifest.linkedIgnoredPaths?.includes("data/experiments"));
	fs.unlinkSync(path.join(plan.childCwd, "data/experiments"));
	fs.mkdirSync(path.join(plan.childCwd, "data/experiments"));
	fs.writeFileSync(path.join(plan.childCwd, "data/experiments/README.md"), "tracked\n");
	command(plan.childCwd, ["switch", "-c", "feat/tracked-experiments"]);
	command(plan.childCwd, ["add", "-f", "data/experiments/README.md"]);
	command(plan.childCwd, ["commit", "-m", "docs: track experiment guide"]);
	assert.equal((await enforceRepository(plan.manifest)).kind, "ok");
	await releaseManagedWorktree(plan.manifest);
	assert.equal(fs.existsSync(plan.childCwd), false);
	assert.equal(command(root, ["show", "feat/tracked-experiments:data/experiments/README.md"]), "tracked");
});

test("preserves ignored directories named .coverage", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), ".coverage/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore coverage"]);
	const plan = await createLaunchPlan(root, agentDir);
	fs.mkdirSync(path.join(plan.childCwd, ".coverage"));
	fs.writeFileSync(path.join(plan.childCwd, ".coverage", "important"), "keep\n");
	await assert.rejects(releaseManagedWorktree(plan.manifest), /Ignored path .coverage/);
	assert.equal(fs.readFileSync(path.join(plan.childCwd, ".coverage", "important"), "utf8"), "keep\n");
});

test("retains global excludes and safely quotes ignored path names", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, "global-excludes"), "*.global.tmp\n");
	command(root, ["config", "core.excludesFile", "global-excludes"]);
	fs.writeFileSync(path.join(root, ".gitignore"), "build[1]/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore build"]);
	fs.writeFileSync(path.join(root, "old.global.tmp"), "global\n");
	// Gitignore brackets are escaped here to match a literal name.
	fs.writeFileSync(path.join(root, ".gitignore"), "build\\[1\\]/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore literal build"]);
	fs.mkdirSync(path.join(root, "build[1]"));
	fs.writeFileSync(path.join(root, "build[1]", "artifact"), "built\n");
	const plan = await createLaunchPlan(root, agentDir);
	assert.equal(fs.readlinkSync(path.join(plan.childCwd, "build[1]")), path.join(fs.realpathSync(root), "build[1]"));
	fs.writeFileSync(path.join(plan.childCwd, "new.global.tmp"), "local\n");
	assert.equal(command(plan.childCwd, ["status", "--porcelain"]), "");
	await assert.rejects(releaseManagedWorktree(plan.manifest), /Ignored path new.global.tmp/);
	assert.equal(fs.readFileSync(path.join(plan.childCwd, "new.global.tmp"), "utf8"), "local\n");
});

test("preserves Git's default XDG global ignore file", async () => {
	const { root, agentDir } = createRepo();
	const previousXdg = process.env.XDG_CONFIG_HOME;
	const xdg = path.join(agentDir, "xdg");
	fs.mkdirSync(path.join(xdg, "git"), { recursive: true });
	fs.writeFileSync(path.join(xdg, "git", "ignore"), "*.global.tmp\n");
	process.env.XDG_CONFIG_HOME = xdg;
	try {
		const plan = await createLaunchPlan(root, agentDir);
		fs.writeFileSync(path.join(plan.childCwd, "new.global.tmp"), "local\n");
		assert.equal(command(plan.childCwd, ["status", "--porcelain"]), "");
		await assert.rejects(releaseManagedWorktree(plan.manifest), /Ignored path new.global.tmp/);
		assert.equal(fs.readFileSync(path.join(plan.childCwd, "new.global.tmp"), "utf8"), "local\n");
	} finally {
		if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = previousXdg;
	}
});

test("creates distinct worktrees for concurrent launches without contending on the real index", async () => {
	const { root, agentDir } = createRepo();
	const plans = await Promise.all(Array.from({ length: 8 }, () => createLaunchPlan(root, agentDir)));

	assert.equal(new Set(plans.map((plan) => plan.manifest.worktreeRoot)).size, plans.length);
	assert.equal(command(root, ["status", "--porcelain"]), "");
});

test("shares the repository session hub across managed worktrees", async () => {
	const { root, agentDir } = createRepo();
	const first = await createLaunchPlan(root, agentDir);
	const firstSessionDir = sessionDirectoryForCwd(first.childCwd, agentDir);
	fs.writeFileSync(path.join(firstSessionDir, "first.jsonl"), '{"type":"session"}\n');
	const second = await createLaunchPlan(root, agentDir);
	const secondSessionDir = sessionDirectoryForCwd(second.childCwd, agentDir);

	assert.equal(fs.realpathSync(firstSessionDir), fs.realpathSync(secondSessionDir));
	assert.equal(fs.readFileSync(path.join(secondSessionDir, "first.jsonl"), "utf8"), '{"type":"session"}\n');
});

test("shares sessions across launch subdirectories and their managed worktrees", async () => {
	const { root, agentDir } = createRepo();
	const firstCwd = path.join(root, "first-subdir");
	const secondCwd = path.join(root, "second-subdir");
	fs.mkdirSync(firstCwd);
	fs.mkdirSync(secondCwd);
	const first = await createLaunchPlan(firstCwd, agentDir);
	const firstLaunchSessions = sessionDirectoryForCwd(firstCwd, agentDir);
	const firstManagedSessions = sessionDirectoryForCwd(first.childCwd, agentDir);
	fs.writeFileSync(path.join(firstManagedSessions, "first.jsonl"), '{"type":"session"}\n');
	const second = await createLaunchPlan(secondCwd, agentDir);
	const secondLaunchSessions = sessionDirectoryForCwd(secondCwd, agentDir);
	const secondManagedSessions = sessionDirectoryForCwd(second.childCwd, agentDir);

	assert.equal(fs.realpathSync(firstLaunchSessions), fs.realpathSync(firstManagedSessions));
	assert.equal(fs.realpathSync(firstManagedSessions), fs.realpathSync(secondLaunchSessions));
	assert.equal(fs.realpathSync(secondLaunchSessions), fs.realpathSync(secondManagedSessions));
	assert.equal(fs.readFileSync(path.join(secondManagedSessions, "first.jsonl"), "utf8"), '{"type":"session"}\n');
});

test("snapshots and publishes a dirty launch checkout automatically", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, "base.txt"), "dirty\n");
	fs.writeFileSync(path.join(root, "untracked.txt"), "untracked\n");
	const plan = await createLaunchPlan(root, agentDir);

	assert.ok(plan.manifest.launchSnapshotCommit);
	assert.equal(fs.readFileSync(path.join(plan.manifest.worktreeRoot, "base.txt"), "utf8"), "dirty\n");
	assert.equal(fs.readFileSync(path.join(plan.manifest.worktreeRoot, "untracked.txt"), "utf8"), "untracked\n");
	assert.equal(command(plan.manifest.worktreeRoot, ["status", "--porcelain"]), "");
	assert.notEqual(command(root, ["status", "--porcelain"]), "");

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "ok");
	assert.equal(command(root, ["status", "--porcelain"]), "");
	assert.equal(fs.readFileSync(path.join(root, "base.txt"), "utf8"), "dirty\n");
	assert.equal(fs.readFileSync(path.join(root, "untracked.txt"), "utf8"), "untracked\n");
	assert.equal(command(root, ["rev-parse", "main"]), command(plan.manifest.worktreeRoot, ["rev-parse", "HEAD"]));
});

test("preserves partially staged launch content in a durable index checkpoint", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, "base.txt"), "staged version\n");
	command(root, ["add", "base.txt"]);
	fs.writeFileSync(path.join(root, "base.txt"), "working version\n");
	const plan = await createLaunchPlan(root, agentDir);

	assert.ok(plan.manifest.launchIndexCommit);
	assert.equal(command(root, ["show", `${plan.manifest.launchIndexCommit}:base.txt`]), "staged version");
	assert.equal(fs.readFileSync(path.join(plan.manifest.worktreeRoot, "base.txt"), "utf8"), "working version\n");
});

test("blocks index-only drift after a dirty launch snapshot", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, "base.txt"), "launch working version\n");
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(root, "base.txt"), "new staged version\n");
	command(root, ["add", "base.txt"]);
	fs.writeFileSync(path.join(root, "base.txt"), "launch working version\n");
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "agent.txt"), "agent\n");
	command(plan.manifest.worktreeRoot, ["add", "agent.txt"]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: agent work"]);

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "blocked");
	assert.match(result.kind === "blocked" ? result.message : "", /index changed/);
	assert.equal(command(root, ["show", ":base.txt"]), "new staged version");
	assert.equal(fs.readFileSync(path.join(root, "base.txt"), "utf8"), "launch working version\n");
});

test("safely applies agent changes on top of a dirty launch snapshot", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, "base.txt"), "launch snapshot\n");
	fs.writeFileSync(path.join(root, "temporary.txt"), "captured untracked file\n");
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "base.txt"), "agent result\n");
	fs.rmSync(path.join(plan.manifest.worktreeRoot, "temporary.txt"));
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "added.txt"), "agent addition\n");
	command(plan.manifest.worktreeRoot, ["add", "-A"]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: update launch snapshot"]);

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "ok");
	assert.equal(command(root, ["status", "--porcelain"]), "");
	assert.equal(fs.readFileSync(path.join(root, "base.txt"), "utf8"), "agent result\n");
	assert.equal(fs.existsSync(path.join(root, "temporary.txt")), false);
	assert.equal(fs.readFileSync(path.join(root, "added.txt"), "utf8"), "agent addition\n");
});

test("preserves a launch checkout that changes after its automatic snapshot", async () => {
	const { root, agentDir } = createRepo();
	const originalHead = command(root, ["rev-parse", "HEAD"]);
	fs.writeFileSync(path.join(root, "base.txt"), "snapshotted\n");
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(root, "base.txt"), "newer local edit\n");

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "blocked");
	assert.match(result.kind === "blocked" ? result.message : "", /changed after its automatic snapshot/);
	assert.equal(fs.readFileSync(path.join(root, "base.txt"), "utf8"), "newer local edit\n");
	assert.equal(command(root, ["rev-parse", "main"]), originalHead);
});

test("asks the agent to commit dirty managed work", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "new.txt"), "work\n");
	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "needs-agent");
});

test("publishes detached commits to the launch branch", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "session.txt"), "session\n");
	command(plan.manifest.worktreeRoot, ["add", "."]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: add session file"]);

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "ok");
	assert.equal(fs.readFileSync(path.join(root, "session.txt"), "utf8"), "session\n");
	assert.equal(command(root, ["rev-parse", "main"]), command(plan.manifest.worktreeRoot, ["rev-parse", "HEAD"]));
	assert.equal(command(root, ["branch", "--format=%(refname:short)"]), "main");
});

test("holds both publication protocols until the new publisher finishes", async () => {
	const { root } = createRepo();
	const gitDir = path.join(fs.realpathSync(root), ".git");
	const release = await acquirePublishLock(gitDir);
	const legacy = path.join(gitDir, "pi-worktree-publish.lock");
	assert.equal(fs.existsSync(legacy), true);
	assert.ok(command(root, ["rev-parse", "--verify", "refs/pi-worktree-locks/publication"]));
	const olderCandidate = path.join(gitDir, "older-publisher.lock");
	fs.mkdirSync(olderCandidate);
	fs.writeFileSync(path.join(olderCandidate, "owner.json"), "old");
	assert.throws(() => fs.renameSync(olderCandidate, legacy), /EEXIST|ENOTEMPTY/);
	await release();
	assert.equal(fs.existsSync(legacy), false);
	assert.throws(() => command(root, ["show-ref", "--verify", "refs/pi-worktree-locks/publication"]));
});

test("reclaims a dead publication owner without a manual lock removal", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.childCwd, "session.txt"), "new\n");
	command(plan.childCwd, ["add", "session.txt"]);
	command(plan.childCwd, ["commit", "-m", "feat: session work"]);
	const lockFile = path.join(root, ".git", "dead-lock.json");
	fs.writeFileSync(lockFile, JSON.stringify({ pid: 99999999, token: "dead" }));
	const oldSha = command(root, ["hash-object", "-w", lockFile]);
	command(root, ["update-ref", "refs/pi-worktree-locks/publication", oldSha]);
	const legacy = path.join(root, ".git", "pi-worktree-publish.lock");
	fs.mkdirSync(legacy);
	fs.writeFileSync(path.join(legacy, "owner.json"), JSON.stringify({ pid: 99999999, token: "old" }));
	assert.equal((await enforceRepository(plan.manifest)).kind, "ok");
	assert.equal(fs.readFileSync(path.join(root, "session.txt"), "utf8"), "new\n");
	assert.throws(() => command(root, ["show-ref", "--verify", "refs/pi-worktree-locks/publication"]));
});

test("waits for a live legacy publisher before publishing", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.childCwd, "session.txt"), "work\n");
	command(plan.childCwd, ["add", "session.txt"]);
	command(plan.childCwd, ["commit", "-m", "feat: session work"]);
	const legacy = path.join(root, ".git", "pi-worktree-publish.lock");
	fs.mkdirSync(legacy);
	fs.writeFileSync(path.join(legacy, "owner.json"), JSON.stringify({ pid: process.pid, token: "live" }));
	let settled = false;
	const publishing = enforceRepository(plan.manifest).then((result) => { settled = true; return result; });
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(settled, false);
	fs.rmSync(legacy, { recursive: true });
	assert.equal((await publishing).kind, "ok");
});

test("reclaims a legacy directory lock after PID reuse", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.childCwd, "session.txt"), "work\n");
	command(plan.childCwd, ["add", "session.txt"]);
	command(plan.childCwd, ["commit", "-m", "feat: session work"]);
	const legacy = path.join(root, ".git", "pi-worktree-publish.lock");
	fs.mkdirSync(legacy);
	fs.writeFileSync(path.join(legacy, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: 1, token: "old" }));
	assert.equal((await enforceRepository(plan.manifest)).kind, "ok");
	assert.equal(fs.existsSync(legacy), false);
	assert.equal(fs.readFileSync(path.join(root, "session.txt"), "utf8"), "work\n");
});

test("reclaims a publication lock whose PID has been reused", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.childCwd, "session.txt"), "work\n");
	command(plan.childCwd, ["add", "session.txt"]);
	command(plan.childCwd, ["commit", "-m", "feat: session work"]);
	const lockFile = path.join(root, ".git", "reused-pid.json");
	fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: "a previous process" }));
	const oldSha = command(root, ["hash-object", "-w", lockFile]);
	command(root, ["update-ref", "refs/pi-worktree-locks/publication", oldSha]);
	assert.equal((await enforceRepository(plan.manifest)).kind, "ok");
	assert.equal(fs.readFileSync(path.join(root, "session.txt"), "utf8"), "work\n");
});

test("blocks publication before overwriting an ignored file", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore generated file"]);
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "ignored.txt"), "session\n");
	command(plan.manifest.worktreeRoot, ["add", "-f", "ignored.txt"]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: track ignored path"]);
	fs.writeFileSync(path.join(root, "ignored.txt"), "local\n");

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "blocked");
	assert.match(result.kind === "blocked" ? result.message : "", /collides with an untracked or ignored path/);
	assert.equal(fs.readFileSync(path.join(root, "ignored.txt"), "utf8"), "local\n");
});

test("blocks an incoming child path beneath an ignored file", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), "ignored\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore collision path"]);
	const plan = await createLaunchPlan(root, agentDir);
	fs.mkdirSync(path.join(plan.manifest.worktreeRoot, "ignored"));
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "ignored", "child.txt"), "session\n");
	command(plan.manifest.worktreeRoot, ["add", "-f", "ignored/child.txt"]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: add child path"]);
	fs.writeFileSync(path.join(root, "ignored"), "local ignored file\n");

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "blocked");
	assert.equal(fs.readFileSync(path.join(root, "ignored"), "utf8"), "local ignored file\n");
});

test("blocks an incoming file above an ignored child path", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), "ignored/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore collision directory"]);
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "ignored"), "session file\n");
	command(plan.manifest.worktreeRoot, ["add", "-f", "ignored"]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: add parent path"]);
	fs.mkdirSync(path.join(root, "ignored"));
	fs.writeFileSync(path.join(root, "ignored", "child.txt"), "local ignored child\n");

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "blocked");
	assert.equal(fs.readFileSync(path.join(root, "ignored", "child.txt"), "utf8"), "local ignored child\n");
});

test("preserves dirty-checkout drift after the branch ref was published", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, "base.txt"), "snapshotted\n");
	const plan = await createLaunchPlan(root, agentDir);
	const newHead = command(plan.manifest.worktreeRoot, ["rev-parse", "HEAD"]);
	plan.manifest.pendingSync = {
		oldHead: plan.manifest.baseSha,
		newHead,
		expectedDirtyTree: plan.manifest.launchSnapshotTree,
		expectedDirtyBase: plan.manifest.baseSha,
		expectedDirtyCommit: plan.manifest.launchSnapshotCommit,
		expectedIndexTree: plan.manifest.launchIndexTree,
		expectedIndexCommit: plan.manifest.launchIndexCommit,
	};
	plan.manifest.publishedHead = newHead;
	await saveManifest(plan.manifest);
	command(root, ["update-ref", "refs/heads/main", newHead, plan.manifest.baseSha]);
	fs.writeFileSync(path.join(root, "base.txt"), "new edit after publication\n");

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "blocked");
	assert.equal(fs.readFileSync(path.join(root, "base.txt"), "utf8"), "new edit after publication\n");
	assert.ok(plan.manifest.pendingSync);
});

test("recovers checkout synchronization after a crash following ref publication", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	const oldHead = command(root, ["rev-parse", "HEAD"]);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "session.txt"), "session\n");
	command(plan.manifest.worktreeRoot, ["add", "."]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: recoverable publication"]);
	const newHead = command(plan.manifest.worktreeRoot, ["rev-parse", "HEAD"]);
	plan.manifest.pendingSync = { oldHead, newHead };
	plan.manifest.publishedHead = newHead;
	await saveManifest(plan.manifest);
	command(root, ["update-ref", "refs/heads/main", newHead, oldHead]);

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "ok");
	assert.equal(fs.readFileSync(path.join(root, "session.txt"), "utf8"), "session\n");
	assert.equal(plan.manifest.pendingSync, undefined);
	assert.equal(command(root, ["status", "--porcelain"]), "");
});

test("leaves an agent-created feature branch untouched", async () => {
	const { root, agentDir } = createRepo();
	const originalMain = command(root, ["rev-parse", "main"]);
	const plan = await createLaunchPlan(root, agentDir);
	command(plan.manifest.worktreeRoot, ["switch", "-c", "feat/agent-choice"]);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "feature.txt"), "feature\n");
	command(plan.manifest.worktreeRoot, ["add", "."]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: agent choice"]);

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "ok");
	assert.equal(command(root, ["rev-parse", "main"]), originalMain);
	assert.equal(command(root, ["rev-parse", "feat/agent-choice"]), command(plan.manifest.worktreeRoot, ["rev-parse", "HEAD"]));
});

test("rebases non-conflicting concurrent work before publishing", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "session.txt"), "session\n");
	command(plan.manifest.worktreeRoot, ["add", "."]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: session change"]);

	fs.writeFileSync(path.join(root, "other.txt"), "other\n");
	command(root, ["add", "."]);
	command(root, ["commit", "-m", "feat: concurrent change"]);

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "ok");
	assert.equal(fs.readFileSync(path.join(root, "session.txt"), "utf8"), "session\n");
	assert.equal(fs.readFileSync(path.join(root, "other.txt"), "utf8"), "other\n");
});

test("preserves a branch commit that lands during rebase", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "session.txt"), "session\n");
	command(plan.manifest.worktreeRoot, ["add", "."]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: session work"]);
	fs.writeFileSync(path.join(root, "concurrent.txt"), "first\n");
	command(root, ["add", "."]);
	command(root, ["commit", "-m", "feat: first concurrent commit"]);

	const hook = path.join(root, ".git", "hooks", "post-rewrite");
	const sentinel = path.join(root, ".git", "pi-race-hook-fired");
	fs.writeFileSync(
		hook,
		`#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX\nif [ ! -f '${sentinel}' ]; then\n  touch '${sentinel}'\n  printf 'second\\n' > '${path.join(root, "during-rebase.txt")}'\n  git -C '${root}' add during-rebase.txt\n  git -C '${root}' commit -m 'feat: commit during rebase' >/dev/null\nfi\n`,
	);
	fs.chmodSync(hook, 0o755);

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "ok", JSON.stringify(result));
	assert.equal(fs.readFileSync(path.join(root, "session.txt"), "utf8"), "session\n");
	assert.equal(fs.readFileSync(path.join(root, "during-rebase.txt"), "utf8"), "second\n");
	const subjects = command(root, ["log", "--format=%s"]);
	assert.match(subjects, /feat: commit during rebase/);
	assert.match(subjects, /feat: session work/);
});

test("serializes concurrent detached publications", async () => {
	const { root, agentDir } = createRepo();
	const first = await createLaunchPlan(root, agentDir);
	const second = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(first.manifest.worktreeRoot, "first.txt"), "first\n");
	command(first.manifest.worktreeRoot, ["add", "."]);
	command(first.manifest.worktreeRoot, ["commit", "-m", "feat: first session"]);
	fs.writeFileSync(path.join(second.manifest.worktreeRoot, "second.txt"), "second\n");
	command(second.manifest.worktreeRoot, ["add", "."]);
	command(second.manifest.worktreeRoot, ["commit", "-m", "feat: second session"]);

	const results = await Promise.all([enforceRepository(first.manifest), enforceRepository(second.manifest)]);
	assert.deepEqual(results.map((result) => result.kind), ["ok", "ok"]);
	assert.equal(fs.readFileSync(path.join(root, "first.txt"), "utf8"), "first\n");
	assert.equal(fs.readFileSync(path.join(root, "second.txt"), "utf8"), "second\n");
});

test("accepts a deleted launch branch when another branch contains the detached commit", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "session.txt"), "session\n");
	command(plan.manifest.worktreeRoot, ["add", "."]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: session work"]);
	const sessionHead = command(plan.manifest.worktreeRoot, ["rev-parse", "HEAD"]);
	command(root, ["branch", "replacement", sessionHead]);
	command(root, ["switch", "--detach"]);
	command(root, ["branch", "-D", "main"]);

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "ok");
	assert.match(result.kind === "ok" ? (result.message ?? "") : "", /already contained in replacement/);
	assert.equal(plan.manifest.publishedHead, sessionHead);
});

test("reports a deleted sole launch branch even after the detached commit was published", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "session.txt"), "session\n");
	command(plan.manifest.worktreeRoot, ["add", "."]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: session work"]);
	assert.equal((await enforceRepository(plan.manifest)).kind, "ok");
	command(root, ["switch", "--detach"]);
	command(root, ["branch", "-D", "main"]);

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "blocked");
	assert.match(result.kind === "blocked" ? result.message : "", /no longer exists/);
});

test("reports a deleted launch branch without losing an unreachable detached commit", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "session.txt"), "session\n");
	command(plan.manifest.worktreeRoot, ["add", "."]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: session work"]);
	command(root, ["switch", "--detach"]);
	command(root, ["branch", "-D", "main"]);

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "blocked");
	assert.match(result.kind === "blocked" ? result.message : "", /no longer exists/);
	assert.equal(command(plan.manifest.worktreeRoot, ["show", "HEAD:session.txt"]), "session");
});

test("returns a repair prompt for a real rebase conflict", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "base.txt"), "session\n");
	command(plan.manifest.worktreeRoot, ["add", "."]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: session edit"]);

	fs.writeFileSync(path.join(root, "base.txt"), "concurrent\n");
	command(root, ["add", "."]);
	command(root, ["commit", "-m", "feat: concurrent edit"]);

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "needs-agent");
	assert.match(result.kind === "needs-agent" ? result.prompt : "", /conflict/i);
	const retry = await enforceRepository(plan.manifest);
	assert.equal(retry.kind, "needs-agent");
	assert.match(retry.kind === "needs-agent" ? retry.prompt : "", /rebase conflict/i);
});

test("releases a finalized worktree and recreates it when the session resumes", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.childCwd, "session.txt"), "session\n");
	command(plan.childCwd, ["add", "session.txt"]);
	command(plan.childCwd, ["commit", "-m", "feat: session"]);
	assert.equal((await enforceRepository(plan.manifest)).kind, "ok");
	const publishedHead = command(root, ["rev-parse", "main"]);
	const sessionFile = path.join(agentDir, "session.jsonl");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "test", cwd: plan.childCwd })}\n{"type":"message"}\n`);

	const record = await checkpointSession(plan.manifest, sessionFile);
	assert.equal(await sessionCwd(sessionFile), record.placeholderCwd);
	assert.equal(command(root, ["rev-parse", record.resumeRef]), publishedHead);
	await releaseManagedWorktree(plan.manifest);
	assert.equal(fs.existsSync(plan.manifest.worktreeRoot), false);
	assert.equal(fs.existsSync(plan.manifest.manifestPath), false);
	assert.deepEqual(await loadResumeRecord(sessionFile), record);

	const resumed = await createResumePlan(record);
	assert.notEqual(resumed.manifest.worktreeRoot, plan.manifest.worktreeRoot);
	assert.equal(command(resumed.childCwd, ["rev-parse", "HEAD"]), publishedHead);
	assert.throws(() => command(resumed.childCwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
	await rewriteSessionCwd(sessionFile, resumed.childCwd);
	await consumeResumeRecord(record);
	assert.equal(await sessionCwd(sessionFile), resumed.childCwd);
	assert.equal(await loadResumeRecord(sessionFile), null);
	assert.throws(() => command(root, ["show-ref", "--verify", record.resumeRef]));
});

test("resumes at an advanced target branch while retaining the session branch identity", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	command(plan.childCwd, ["switch", "-c", "feat/session"]);
	fs.writeFileSync(path.join(plan.childCwd, "feature.txt"), "feature\n");
	command(plan.childCwd, ["add", "feature.txt"]);
	command(plan.childCwd, ["commit", "-m", "feat: feature"]);
	assert.equal((await enforceRepository(plan.manifest)).kind, "ok");
	assert.equal(plan.manifest.targetBranch, "feat/session");
	const sessionFile = path.join(agentDir, "feature.jsonl");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "feature", cwd: plan.childCwd })}\n`);
	const record = await checkpointSession(plan.manifest, sessionFile);
	await releaseManagedWorktree(plan.manifest);

	command(root, ["switch", "feat/session"]);
	fs.writeFileSync(path.join(root, "later.txt"), "later\n");
	command(root, ["add", "later.txt"]);
	command(root, ["commit", "-m", "feat: later"]);
	const advancedHead = command(root, ["rev-parse", "HEAD"]);
	const resumed = await createResumePlan(record);

	assert.equal(resumed.manifest.targetBranch, "feat/session");
	assert.equal(command(resumed.childCwd, ["rev-parse", "HEAD"]), advancedHead);
	assert.throws(() => command(resumed.childCwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
});

test("does not checkpoint or release an unsafe worktree", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	const sessionFile = path.join(agentDir, "dirty.jsonl");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "dirty", cwd: plan.childCwd })}\n`);
	fs.writeFileSync(path.join(plan.childCwd, "dirty.txt"), "dirty\n");

	await assert.rejects(checkpointSession(plan.manifest, sessionFile), /uncommitted changes/);
	await assert.rejects(releaseManagedWorktree(plan.manifest), /not clean/);
	assert.equal(fs.existsSync(plan.manifest.worktreeRoot), true);
	assert.equal(await loadResumeRecord(sessionFile), null);
});

test("preserves ignored branch outputs without moving them into main", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), "results/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore results"]);
	const plan = await createLaunchPlan(root, agentDir, "feat/experiment");
	assert.equal(command(plan.childCwd, ["branch", "--show-current"]), "feat/experiment");
	fs.mkdirSync(path.join(plan.childCwd, "results"));
	fs.writeFileSync(path.join(plan.childCwd, "results", "result.bin"), "important\n");
	await assert.rejects(releaseManagedWorktree(plan.manifest), /Ignored path results/);
	assert.equal(fs.readFileSync(path.join(plan.childCwd, "results/result.bin"), "utf8"), "important\n");
	assert.equal(fs.existsSync(path.join(root, "results")), false);
	plan.manifest.ownerPid = 99999999;
	await saveManifest(plan.manifest);
	assert.deepEqual(await reapStaleWorktrees(root), []);
	assert.equal(fs.existsSync(plan.childCwd), true);
});

test("managed feature sessions expose cleanup but do not auto-release on quit", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir, "feat/keep");
	fs.writeFileSync(path.join(plan.childCwd, "work.txt"), "pending\n");
	command(plan.childCwd, ["add", "work.txt"]);
	command(plan.childCwd, ["commit", "-m", "feat: pending cleanup"]);
	const tools = new Map<string, {
		execute: (...args: unknown[]) => Promise<unknown>;
		renderCall?: BranchRenderCall;
		renderResult?: BranchRenderResult;
	}>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>();
	const continuations: Array<{ customType: string; content: string; display: boolean; triggerTurn: boolean }> = [];
	const pi = {
		registerFlag: () => undefined,
		sendMessage: (message: { customType: string; content: string; display: boolean }, options: { triggerTurn: boolean }) => {
			continuations.push({ ...message, ...options });
			queueMicrotask(() => {
				for (const handler of handlers.get("agent_settled") ?? []) void handler({});
			});
		},
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, options);
		},
		getFlag: () => false,
		exec: async () => ({ code: 0, stdout: `${plan.childCwd}\n` }),
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown>; renderCall?: BranchRenderCall; renderResult?: BranchRenderResult }) => { tools.set(tool.name, tool); },
		on: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			return () => handlers.set(name, (handlers.get(name) ?? []).filter((item) => item !== handler));
		},
	} as unknown as ExtensionAPI;
	await registerIsolation(pi);
	assert.ok(tools.has("clean_up_isolated_branch"));
	assert.ok(commands.has("clean_up_isolated_branch"));
	const branchTool = tools.get("isolated_new_branch")!;
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const savedResult = { content: [{ type: "text" as const, text: `Created feat/keep at ${plan.childCwd}. Continuing this session there now.` }] };
	assert.equal(branchTool.renderCall!({ name: "feat/keep" }, theme).render(100).join("").trimEnd(), "isolated_new_branch feat/keep");
	assert.equal(branchTool.renderResult!(savedResult, { expanded: false, isPartial: false }, theme, { isError: false }).render(100).join("").trimEnd(), "✓ switched to new branch");
	assert.match(branchTool.renderResult!(savedResult, { expanded: true, isPartial: false }, theme, { isError: false }).render(200).join(""), /Created feat\/keep at/);
	await assert.rejects(branchTool.execute("call", { name: "feat/nested" }), /already active/);
	const sessionFile = path.join(agentDir, "current.jsonl");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", cwd: plan.childCwd })}\n`);
	const previousContinuation = process.env.PI_WORKTREE_BRANCH_CONTINUATION;
	const previousArgv = process.argv;
	process.argv = ["node", "pi", "--print"];
	process.env.PI_WORKTREE_BRANCH_CONTINUATION = "1";
	try {
		for (const handler of handlers.get("session_start") ?? []) {
			await handler({ reason: "startup" }, {
				sessionManager: { getSessionFile: () => sessionFile },
				ui: { setStatus: () => undefined },
			});
		}
		assert.equal(process.env.PI_WORKTREE_BRANCH_CONTINUATION, undefined);
		assert.deepEqual(continuations, [{
			customType: "git-worktree-isolation:continue-branch",
			content: "Continue the previous request using the branch-creation result above. Creating the branch does not finish the request or the current loop iteration.",
			display: false,
			triggerTurn: true,
		}]);
	} finally {
		process.argv = previousArgv;
		if (previousContinuation === undefined) delete process.env.PI_WORKTREE_BRANCH_CONTINUATION;
		else process.env.PI_WORKTREE_BRANCH_CONTINUATION = previousContinuation;
	}
	let aborted = false;
	await assert.rejects(tools.get("clean_up_isolated_branch")!.execute("call", {}, undefined, undefined, {
		sessionManager: { getSessionFile: () => sessionFile },
		abort: () => { aborted = true; },
	}), /ask the user before merging/);
	assert.equal(aborted, false);
	const notifications: string[] = [];
	const widgets: Array<string | undefined> = [];
	await commands.get("clean_up_isolated_branch")!.handler("", {
		isIdle: () => true,
		sessionManager: { getSessionFile: () => sessionFile },
		hasUI: true,
		mode: "tui",
		ui: {
			notify: (message: string) => { notifications.push(message); },
			setWidget: (_key: string, content?: unknown) => { widgets.push(content ? "spinner" : undefined); },
		},
	});
	assert.deepEqual(widgets, ["spinner", undefined], "idle cleanup animates and clears progress on failure");
	assert.match(notifications.join("\n"), /ask the user before merging/);
	for (const handler of handlers.get("session_shutdown") ?? []) {
		await handler({ reason: "quit" }, { sessionManager: { getSessionFile: () => sessionFile } });
	}
	assert.equal(fs.existsSync(plan.childCwd), true);
	assert.equal(await sessionCwd(sessionFile), plan.childCwd);
});

test("discard removes unmerged commits and dirty files while preserving main and linked targets", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), "shared/\n.env\nresults/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore local files"]);
	fs.mkdirSync(path.join(root, "shared"));
	fs.writeFileSync(path.join(root, "shared", "keep"), "original\n");
	fs.writeFileSync(path.join(root, ".env"), "keep\n");
	const plan = await createLaunchPlan(root, agentDir, "feat/abandoned");
	fs.writeFileSync(path.join(plan.childCwd, "feature.txt"), "abandoned\n");
	command(plan.childCwd, ["add", "feature.txt"]);
	command(plan.childCwd, ["commit", "-m", "feat: abandoned work"]);
	const dir = sessionDirectoryForCwd(plan.childCwd, agentDir);
	const current = path.join(dir, "current.jsonl");
	const older = path.join(dir, "older.jsonl");
	const nested = path.join(plan.childCwd, "only-on-branch");
	fs.mkdirSync(nested);
	fs.writeFileSync(current, `${JSON.stringify({ type: "session", cwd: plan.childCwd })}\n`);
	fs.writeFileSync(older, `${JSON.stringify({ type: "session", cwd: nested })}\n`);
	const checkpoint = await checkpointSession(plan.manifest, older);
	// Replaced ignored links and arbitrary ignored output are discarded too.
	fs.unlinkSync(path.join(plan.childCwd, ".env"));
	fs.writeFileSync(path.join(plan.childCwd, ".env"), "local replacement\n");
	fs.mkdirSync(path.join(plan.childCwd, "results"));
	fs.writeFileSync(path.join(plan.childCwd, "results", "output"), "local\n");
	fs.writeFileSync(path.join(plan.childCwd, "base.txt"), "staged\n");
	command(plan.childCwd, ["add", "base.txt"]);
	fs.writeFileSync(path.join(plan.childCwd, "base.txt"), "unstaged\n");
	fs.writeFileSync(path.join(plan.childCwd, "untracked.txt"), "local\n");
	const mainSha = command(root, ["rev-parse", "HEAD"]);
	fs.writeFileSync(path.join(root, "main-untracked.txt"), "keep\n");
	await assert.rejects(prepareBranchCleanup(plan.manifest), /not clean/);
	const { mainRoot, branchSha } = await prepareBranchDiscard(plan.manifest);
	assert.equal(await finishBranchDiscard(plan.manifest, current, mainRoot, branchSha), fs.realpathSync(root));
	assert.equal(fs.existsSync(plan.childCwd), false);
	assert.equal(fs.existsSync(plan.manifest.manifestPath), false);
	assert.equal(command(root, ["branch", "--list", "feat/abandoned"]), "");
	assert.equal(command(root, ["rev-parse", "HEAD"]), mainSha);
	assert.equal(fs.readFileSync(path.join(root, "base.txt"), "utf8"), "base\n");
	assert.equal(fs.readFileSync(path.join(root, "main-untracked.txt"), "utf8"), "keep\n");
	assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), "keep\n");
	assert.equal(fs.readFileSync(path.join(root, "shared", "keep"), "utf8"), "original\n");
	assert.equal(fs.existsSync(path.join(root, "feature.txt")), false);
	for (const file of [current, older]) {
		assert.equal(await sessionCwd(file), fs.realpathSync(root));
		assert.equal(await loadResumeRecord(file), null);
	}
	assert.equal(command(root, ["for-each-ref", "--format=%(refname)", checkpoint.resumeRef]), "");
});

test("discard rejects legacy, switched, detached, and main branches", async () => {
	const { root, agentDir } = createRepo();
	const legacy = await createLaunchPlan(root, agentDir);
	await assert.rejects(prepareBranchDiscard(legacy.manifest), /original isolated feature branch/);
	const plan = await createLaunchPlan(root, agentDir, "feat/owned");
	command(plan.childCwd, ["switch", "-c", "feat/not-owned"]);
	await assert.rejects(prepareBranchDiscard(plan.manifest), /original isolated feature branch/);
	command(plan.childCwd, ["switch", "--detach"]);
	await assert.rejects(prepareBranchDiscard(plan.manifest), /original isolated feature branch/);
	await assert.rejects(prepareBranchDiscard({ ...plan.manifest, createdBranch: "main" }), /original isolated feature branch/);
	assert.equal(fs.existsSync(plan.childCwd), true);
});

test("discard rechecks feature HEAD and main before removing anything", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir, "feat/moved");
	const current = path.join(sessionDirectoryForCwd(plan.childCwd, agentDir), "current.jsonl");
	fs.writeFileSync(current, `${JSON.stringify({ type: "session", cwd: plan.childCwd })}\n`);
	const prepared = await prepareBranchDiscard(plan.manifest);
	fs.writeFileSync(path.join(plan.childCwd, "new.txt"), "new\n");
	command(plan.childCwd, ["add", "new.txt"]);
	command(plan.childCwd, ["commit", "-m", "feat: moved"]);
	await assert.rejects(finishBranchDiscard(plan.manifest, current, prepared.mainRoot, prepared.branchSha), /moved during discard/);
	assert.equal(await sessionCwd(current), plan.childCwd);
	const retry = await prepareBranchDiscard(plan.manifest);
	command(root, ["switch", "-c", "other-main"]);
	await assert.rejects(finishBranchDiscard(plan.manifest, current, retry.mainRoot, retry.branchSha), /separate main worktree/);
	assert.equal(fs.existsSync(plan.childCwd), true);
});

test("discard locks checkout state throughout transcript migration and releases locks on failure", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir, "feat/locked-discard");
	command(root, ["branch", "feat/unrelated"]);
	const current = path.join(sessionDirectoryForCwd(plan.childCwd, agentDir), "current.jsonl");
	fs.writeFileSync(current, `${JSON.stringify({ type: "session", cwd: plan.childCwd })}\n`);
	const { mainRoot, branchSha } = await prepareBranchDiscard(plan.manifest);
	const rename = fs.promises.rename;
	let attemptedSwitch = false;
	fs.promises.rename = async (from, to) => {
		if (String(to) === `${fs.realpathSync(current)}.pi-worktree.json`) {
			attemptedSwitch = true;
			assert.throws(() => command(plan.childCwd, ["switch", "feat/unrelated"]), /index.lock/);
			assert.throws(() => command(plan.childCwd, ["symbolic-ref", "HEAD", "refs/heads/feat/unrelated"]), /HEAD.lock/);
		}
		return rename(from, to);
	};
	try {
		await finishBranchDiscard(plan.manifest, current, mainRoot, branchSha);
	} finally {
		fs.promises.rename = rename;
	}
	assert.equal(attemptedSwitch, true);
	assert.equal(command(root, ["branch", "--list", "feat/unrelated"]), "feat/unrelated");
	const failed = await createLaunchPlan(root, agentDir, "feat/failed-discard");
	const prepared = await prepareBranchDiscard(failed.manifest);
	const indexLock = command(failed.childCwd, ["rev-parse", "--git-path", "index.lock"]);
	const headLock = command(failed.childCwd, ["rev-parse", "--git-path", "HEAD.lock"]);
	fs.writeFileSync(headLock, "another Git process\n");
	await assert.rejects(finishBranchDiscard(failed.manifest, current, prepared.mainRoot, prepared.branchSha), /EEXIST/);
	assert.equal(fs.existsSync(indexLock), false);
	assert.equal(fs.readFileSync(headLock, "utf8"), "another Git process\n");
});

test("discard refuses pending synchronization and in-progress Git operations", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir, "feat/busy");
	await assert.rejects(prepareBranchDiscard({ ...plan.manifest, pendingSync: {} as NonNullable<typeof plan.manifest.pendingSync> }), /still in progress/);
	const mergeHead = command(plan.childCwd, ["rev-parse", "--git-path", "MERGE_HEAD"]);
	fs.writeFileSync(mergeHead, `${command(root, ["rev-parse", "HEAD"])}\n`);
	await assert.rejects(prepareBranchDiscard(plan.manifest), /still in progress/);
	assert.equal(fs.existsSync(plan.childCwd), true);
});

test("discard preserves worktree and transcripts when another saved session is active", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir, "feat/active");
	const dir = sessionDirectoryForCwd(plan.childCwd, agentDir);
	const current = path.join(dir, "current.jsonl");
	const other = path.join(dir, "other.jsonl");
	for (const file of [current, other]) fs.writeFileSync(file, `${JSON.stringify({ type: "session", cwd: plan.childCwd })}\n`);
	const release = await acquireSessionLease(other);
	try {
		const { mainRoot, branchSha } = await prepareBranchDiscard(plan.manifest);
		await assert.rejects(finishBranchDiscard(plan.manifest, current, mainRoot, branchSha), /already active/);
		assert.equal(fs.existsSync(plan.childCwd), true);
		assert.equal(await sessionCwd(current), plan.childCwd);
		assert.equal(await sessionCwd(other), plan.childCwd);
	} finally {
		await release();
	}
});

for (const toolName of ["discard_isolated_branch", "clean_up_isolated_branch"]) {
	for (const mixed of [false, true]) {
		test(`${toolName} ends the old run before another edit can be requested (${mixed ? "mixed retry" : "standalone"})`, async () => {
			const { root, agentDir } = createRepo();
			const plan = await createLaunchPlan(root, agentDir, "feat/stop-before-edit");
			const current = path.join(sessionDirectoryForCwd(plan.childCwd, agentDir), "current.jsonl");
			fs.writeFileSync(current, `${JSON.stringify({ type: "session", cwd: plan.childCwd })}\n`);
			const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ type: "text"; text: string }>; terminate?: boolean }> }>();
			const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
			const previousToken = process.env.PI_PROFILE_RELOAD_TOKEN;
			process.env.PI_PROFILE_RELOAD_TOKEN = "cleanup-regression";
			try {
				await registerIsolation({
					registerFlag: () => undefined, registerCommand: () => undefined,
					getFlag: () => false,
					exec: async () => ({ code: 0, stdout: `${plan.childCwd}\n` }),
					registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ type: "text"; text: string }>; terminate?: boolean }> }) => { tools.set(tool.name, tool); },
					on: (name: string, handler: (...args: unknown[]) => unknown) => {
						handlers.set(name, [...(handlers.get(name) ?? []), handler]);
					},
					sendMessage: () => assert.fail("cleanup must not queue another turn in the old worktree"),
				} as unknown as ExtensionAPI);
				const ctx = { sessionManager: { getSessionFile: () => current } };
				// A nested cleanup cannot terminate its outer codemode call either.
				for (const handler of handlers.get("message_end") ?? []) {
					await handler({ message: { role: "assistant", content: [{ type: "toolCall", id: "wrapper", name: "codemode", arguments: {} }] } }, ctx);
				}
				for (const handler of handlers.get("tool_call") ?? []) {
					const blocked = await handler({ toolName, toolCallId: "nested-cleanup" }, ctx) as BeforeToolCallResult;
					assert.equal(blocked.block, true);
					assert.match(blocked.reason!, /Cleanup has not started/);
				}
				let requests = 0;
				let cleanups = 0;
				const model: Model<"openai-completions"> = {
					id: "cleanup-test", name: "Cleanup test", api: "openai-completions", provider: "openai",
					baseUrl: "https://example.invalid", input: ["text"], reasoning: false,
					contextWindow: 128000, maxTokens: 1000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				};
				const agent = new Agent({
					initialState: { model, tools: [
						{ name: "read", label: "Read", description: "Read", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "read" }] }) },
						{ name: toolName, label: toolName, description: toolName, parameters: Type.Object({}), execute: async () => {
							cleanups++;
							return tools.get(toolName)!.execute("cleanup", {}, undefined, undefined, ctx);
						} },
					] },
					beforeToolCall: async ({ toolCall }) => {
						for (const handler of handlers.get("tool_call") ?? []) {
							const result = await handler({ toolName: toolCall.name, toolCallId: toolCall.id }, ctx) as BeforeToolCallResult | undefined;
							if (result?.block) return result;
						}
					},
					streamFn: () => {
						requests++;
						assert.ok(requests <= (mixed ? 2 : 1), "cleanup must settle before the model can request an edit");
						if (mixed && requests === 2) assert.equal(cleanups, 0, "mixed cleanup is blocked before preparation");
						const message: AssistantMessage = {
							role: "assistant", api: model.api, provider: model.provider, model: model.id,
							content: [
								...(mixed && requests === 1 ? [{ type: "toolCall" as const, id: "read", name: "read", arguments: {} }] : []),
								{ type: "toolCall", id: "cleanup", name: toolName, arguments: {} },
							],
							stopReason: "toolUse", timestamp: Date.now(),
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						};
						const stream = createAssistantMessageEventStream();
						stream.push({ type: "done", reason: "toolUse", message });
						stream.end();
						return stream;
					},
				});
				agent.subscribe(async (event) => {
					for (const handler of handlers.get(event.type) ?? []) await handler(event, ctx);
				});
				await agent.prompt("Discard or clean up, then continue on main.");
				assert.equal(requests, mixed ? 2 : 1);
				assert.equal(cleanups, 1);
				assert.equal(agent.state.errorMessage, undefined);
				const results = agent.state.messages.filter((message) => message.role === "toolResult");
				assert.equal(results.filter((result) => result.isError).length, mixed ? 1 : 0);
				assert.doesNotMatch(JSON.stringify(results), /Branch cleanup is already in progress/);
				assert.equal(fs.existsSync(plan.childCwd), true, "removal waits for the persisted result and agent settlement");
				assert.ok(handlers.get("agent_settled")?.length, "the stopped run must still hand off to main");
			} finally {
				if (previousToken === undefined) delete process.env.PI_PROFILE_RELOAD_TOKEN;
				else process.env.PI_PROFILE_RELOAD_TOKEN = previousToken;
			}
		});
	}
}

test("discard tool queues removal after its result and blocks later tool calls and finalization", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir, "feat/discard-tool");
	const current = path.join(sessionDirectoryForCwd(plan.childCwd, agentDir), "current.jsonl");
	fs.writeFileSync(current, `${JSON.stringify({ type: "session", cwd: plan.childCwd })}\n`);
	fs.writeFileSync(path.join(plan.childCwd, "dirty.txt"), "abandon\n");
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	await registerIsolation({
		registerFlag: () => undefined, registerCommand: () => undefined,
		getFlag: () => false,
		exec: async () => ({ code: 0, stdout: `${plan.childCwd}\n` }),
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => { tools.set(tool.name, tool); },
		on: (name: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		sendMessage: () => assert.fail("pending discard must not trigger a commit-repair turn"),
	} as unknown as ExtensionAPI);
	const ctx = { sessionManager: { getSessionFile: () => current } };
	await tools.get("discard_isolated_branch")!.execute("call", {}, undefined, undefined, ctx);
	assert.equal(fs.existsSync(plan.childCwd), true, "deletion waits until the tool result is persisted");
	assert.deepEqual(await handlers.get("tool_call")![0]!(), {
		block: true, reason: "Branch cleanup is already in progress.", terminate: true,
	});
	for (const handler of handlers.get("agent_end") ?? []) await handler({}, ctx);
	await assert.rejects(tools.get("discard_isolated_branch")!.execute("again", {}, undefined, undefined, ctx), /already in progress/);
});

test("cleanup refuses an unmerged feature branch and preserves its worktree", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir, "feat/pending");
	fs.writeFileSync(path.join(plan.childCwd, "work.txt"), "not merged\n");
	command(plan.childCwd, ["add", "work.txt"]);
	command(plan.childCwd, ["commit", "-m", "feat: pending work"]);
	await assert.rejects(prepareBranchCleanup(plan.manifest), /ask the user before merging/);
	plan.manifest.ownerPid = 99999999;
	await saveManifest(plan.manifest);
	assert.deepEqual(await reapStaleWorktrees(root), []);
	assert.equal(fs.existsSync(plan.childCwd), true);
	assert.equal(command(root, ["branch", "--list", "feat/pending"]), "+ feat/pending");
});

test("cleanup migrates saved sessions after main contains the branch", async () => {
	const { root, agentDir } = createRepo();
	fs.mkdirSync(path.join(root, "nested"));
	fs.writeFileSync(path.join(root, "nested", "tracked.txt"), "tracked\n");
	command(root, ["add", "nested"]);
	command(root, ["commit", "-m", "chore: add nested directory"]);
	const plan = await createLaunchPlan(root, agentDir, "feat/merged");
	fs.writeFileSync(path.join(plan.childCwd, "work.txt"), "merged\n");
	command(plan.childCwd, ["add", "work.txt"]);
	command(plan.childCwd, ["commit", "-m", "feat: merged work"]);
	const sessionDir = sessionDirectoryForCwd(plan.childCwd, agentDir);
	const current = path.join(sessionDir, "current.jsonl");
	const older = path.join(sessionDir, "older.jsonl");
	fs.writeFileSync(current, `${JSON.stringify({ type: "session", cwd: plan.childCwd })}\n`);
	fs.writeFileSync(older, `${JSON.stringify({ type: "session", cwd: path.join(plan.childCwd, "nested") })}\n`);
	await checkpointSession(plan.manifest, older);
	command(root, ["merge", "--ff-only", "feat/merged"]);
	const { mainRoot, branchSha } = await prepareBranchCleanup(plan.manifest);
	assert.equal(mainRoot, fs.realpathSync(root));
	assert.equal(await finishBranchCleanup(plan.manifest, current, mainRoot, branchSha), fs.realpathSync(root));
	assert.equal(fs.existsSync(plan.childCwd), false);
	assert.equal(command(root, ["branch", "--list", "feat/merged"]), "");
	assert.equal(await sessionCwd(current), fs.realpathSync(root));
	assert.equal(await sessionCwd(older), path.join(fs.realpathSync(root), "nested"));
	for (const file of [current, older]) assert.equal(await loadResumeRecord(file), null);
});

test("cleanup returns detached managed sessions to main after their feature branch was deleted", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir, "feat/deleted");
	fs.writeFileSync(path.join(plan.childCwd, "work.txt"), "merged\n");
	command(plan.childCwd, ["add", "work.txt"]);
	command(plan.childCwd, ["commit", "-m", "feat: merged work"]);
	const sessionDir = sessionDirectoryForCwd(plan.childCwd, agentDir);
	const current = path.join(sessionDir, "current.jsonl");
	const older = path.join(sessionDir, "older.jsonl");
	fs.writeFileSync(current, `${JSON.stringify({ type: "session", cwd: plan.childCwd })}\n`);
	fs.writeFileSync(older, `${JSON.stringify({ type: "session", cwd: plan.childCwd })}\n`);
	await checkpointSession(plan.manifest, older);
	command(root, ["merge", "--ff-only", "feat/deleted"]);
	command(plan.childCwd, ["switch", "--detach"]);
	command(root, ["branch", "-D", "feat/deleted"]);
	const { mainRoot, branchSha, branchExists } = await prepareBranchCleanup(plan.manifest);
	assert.equal(branchExists, false);
	assert.equal(branchSha, command(root, ["rev-parse", "main"]));
	assert.equal(await finishBranchCleanup(plan.manifest, current, mainRoot, branchSha, branchExists), fs.realpathSync(root));
	assert.equal(fs.existsSync(plan.childCwd), false);
	assert.equal(await sessionCwd(current), fs.realpathSync(root));
	assert.equal(await sessionCwd(older), fs.realpathSync(root));
	assert.equal(await loadResumeRecord(older), null);
});

test("cleanup retires a legacy managed worktree whose target branch was deleted", async () => {
	const { root, agentDir } = createRepo();
	command(root, ["branch", "feat/legacy"]);
	const plan = await createLaunchPlan(root, agentDir);
	plan.manifest.targetBranch = "feat/legacy";
	plan.manifest.targetRef = "refs/heads/feat/legacy";
	await saveManifest(plan.manifest);
	command(root, ["branch", "-D", "feat/legacy"]);
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown>; renderResult: BranchRenderResult }>();
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	await registerIsolation({
		registerFlag: () => undefined,
		registerCommand: () => undefined,
		getFlag: () => false,
		exec: async () => ({ code: 0, stdout: `${plan.childCwd}\n` }),
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown>; renderResult: BranchRenderResult }) => { tools.set(tool.name, tool); },
		on: (name: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	} as unknown as ExtensionAPI);
	const sessionFile = path.join(agentDir, "current.jsonl");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", cwd: plan.childCwd })}\n`);
	const cleanupGuard = handlers.get("tool_call")?.at(-1);
	assert.equal(cleanupGuard?.({ toolName: "edit", toolCallId: "before-cleanup" }), undefined);
	let aborted = false;
	const result = await tools.get("clean_up_isolated_branch")!.execute("call", {}, undefined, undefined, {
		sessionManager: { getSessionFile: () => sessionFile },
		abort: () => { aborted = true; },
	});
	const render = tools.get("clean_up_isolated_branch")!.renderResult;
	const theme = { fg: (_color: string, text: string) => text };
	const output = result as { content: Array<{ type: "text"; text: string }> };
	assert.equal(render(output, { expanded: false, isPartial: true }, theme, { isError: false }).render(100).join("").trimEnd(), "⋯ cleaning up branch");
	assert.equal(render(output, { expanded: false, isPartial: false }, theme, { isError: false }).render(100).join("").trimEnd(), "✓ cleaned up branch and worktree");
	assert.match(render(output, { expanded: true, isPartial: false }, theme, { isError: false }).render(200).join(""), /Verified this worktree/);
	assert.equal(aborted, false, "cleanup handoff must not abort the agent run");
	assert.deepEqual(cleanupGuard?.(), {
		block: true, reason: "Branch cleanup is already in progress.", terminate: true,
	});
	assert.ok(handlers.get("turn_end")?.length, "cleanup waits until the tool result is persisted");
	const { mainRoot, branchSha, branchExists } = await prepareBranchCleanup(plan.manifest);
	assert.equal(branchExists, false);
	assert.equal(await finishBranchCleanup(plan.manifest, sessionFile, mainRoot, branchSha, branchExists), fs.realpathSync(root));
	assert.equal(fs.existsSync(plan.childCwd), false);
	assert.equal(await sessionCwd(sessionFile), fs.realpathSync(root));
});

test("cleanup releases a managed worktree on an agent-selected branch without deleting it", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	command(plan.childCwd, ["switch", "-c", "feat/manual"]);
	fs.writeFileSync(path.join(plan.childCwd, "work.txt"), "merged\n");
	command(plan.childCwd, ["add", "work.txt"]);
	command(plan.childCwd, ["commit", "-m", "feat: manual branch"]);
	await enforceRepository(plan.manifest);
	const sessionFile = path.join(agentDir, "current.jsonl");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", cwd: plan.childCwd })}\n`);
	await assert.rejects(prepareBranchCleanup(plan.manifest), /ask the user before merging/);
	command(root, ["merge", "--ff-only", "feat/manual"]);
	const { mainRoot, branchSha, branchExists } = await prepareBranchCleanup(plan.manifest);
	assert.equal(branchExists, true);
	assert.equal(await finishBranchCleanup(plan.manifest, sessionFile, mainRoot, branchSha, branchExists), fs.realpathSync(root));
	assert.equal(fs.existsSync(plan.childCwd), false);
	assert.equal(command(root, ["rev-parse", "refs/heads/feat/manual"]), branchSha);
	assert.equal(await sessionCwd(sessionFile), fs.realpathSync(root));
});

test("cleanup releases a detached legacy worktree while preserving its existing target branch", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	const other = await createLaunchPlan(root, agentDir);
	const sessionFile = path.join(agentDir, "current.jsonl");
	const unrelated = path.join(agentDir, "unrelated.jsonl");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", cwd: plan.childCwd })}\n`);
	fs.writeFileSync(unrelated, `${JSON.stringify({ type: "session", cwd: other.childCwd })}\n`);
	await checkpointSession(other.manifest, unrelated);
	const unrelatedRecord = await loadResumeRecord(unrelated);
	const { mainRoot, branchSha, branchExists } = await prepareBranchCleanup(plan.manifest);
	assert.equal(branchExists, true);
	assert.equal(await finishBranchCleanup(plan.manifest, sessionFile, mainRoot, branchSha, branchExists), fs.realpathSync(root));
	assert.equal(fs.existsSync(plan.childCwd), false);
	assert.equal(command(root, ["branch", "--show-current"]), "main");
	assert.deepEqual(await loadResumeRecord(unrelated), unrelatedRecord);
	assert.equal(await sessionCwd(unrelated), unrelatedRecord!.placeholderCwd);
});

test("cleanup preserves a detached worktree if its deleted branch has unmerged work", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir, "feat/unmerged-deleted");
	fs.writeFileSync(path.join(plan.childCwd, "work.txt"), "not merged\n");
	command(plan.childCwd, ["add", "work.txt"]);
	command(plan.childCwd, ["commit", "-m", "feat: unmerged work"]);
	command(plan.childCwd, ["switch", "--detach"]);
	command(root, ["branch", "-D", "feat/unmerged-deleted"]);
	await assert.rejects(prepareBranchCleanup(plan.manifest), /ask the user before merging/);
	assert.equal(fs.existsSync(plan.childCwd), true);
});

test("cleanup rejects a ref recreated after missing-branch verification", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir, "feat/recreated");
	command(root, ["merge", "--ff-only", "feat/recreated"]);
	command(plan.childCwd, ["switch", "--detach"]);
	command(root, ["branch", "-D", "feat/recreated"]);
	const { mainRoot, branchSha, branchExists } = await prepareBranchCleanup(plan.manifest);
	command(root, ["branch", "feat/recreated"]);
	const sessionFile = path.join(agentDir, "current.jsonl");
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", cwd: plan.childCwd })}\n`);
	await assert.rejects(finishBranchCleanup(plan.manifest, sessionFile, mainRoot, branchSha, branchExists), /moved during cleanup/);
	assert.equal(fs.existsSync(plan.childCwd), true);
});

test("cleanup accepts a squash merge but refuses dirty ignored outputs", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), "results/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore results"]);
	const plan = await createLaunchPlan(root, agentDir, "feat/squashed");
	fs.writeFileSync(path.join(plan.childCwd, "work.txt"), "squashed\n");
	command(plan.childCwd, ["add", "work.txt"]);
	command(plan.childCwd, ["commit", "-m", "feat: work"]);
	command(root, ["merge", "--squash", "feat/squashed"]);
	command(root, ["commit", "-m", "feat: squash work"]);
	assert.equal((await prepareBranchCleanup(plan.manifest)).mainRoot, fs.realpathSync(root));
	fs.mkdirSync(path.join(plan.childCwd, "results"));
	fs.writeFileSync(path.join(plan.childCwd, "results", "output"), "important\n");
	await assert.rejects(prepareBranchCleanup(plan.manifest), /Ignored path results/);
	assert.equal(fs.existsSync(path.join(plan.childCwd, "results", "output")), true);
});

test("cleanup fast-forwards a clean local main from origin/main", async () => {
	const { root, agentDir } = createRepo();
	const bare = path.join(path.dirname(root), "remote.git");
	command(root, ["init", "--bare", bare]);
	command(root, ["remote", "add", "origin", bare]);
	command(root, ["push", "origin", "main"]);
	const plan = await createLaunchPlan(root, agentDir, "feat/remote");
	fs.writeFileSync(path.join(plan.childCwd, "work.txt"), "remote\n");
	command(plan.childCwd, ["add", "work.txt"]);
	command(plan.childCwd, ["commit", "-m", "feat: remote work"]);
	command(plan.childCwd, ["push", "origin", "HEAD:main"]);
	assert.notEqual(command(root, ["rev-parse", "main"]), command(plan.childCwd, ["rev-parse", "HEAD"]));
	assert.equal((await prepareBranchCleanup(plan.manifest)).branchSha, command(root, ["rev-parse", "main"]));
});

test("cleanup accepts local main when origin has no main branch", async () => {
	const { root, agentDir } = createRepo();
	const bare = path.join(path.dirname(root), "empty-origin.git");
	command(root, ["init", "--bare", bare]);
	command(root, ["remote", "add", "origin", bare]);
	const plan = await createLaunchPlan(root, agentDir, "feat/local");
	fs.writeFileSync(path.join(plan.childCwd, "work.txt"), "locally merged\n");
	command(plan.childCwd, ["add", "work.txt"]);
	command(plan.childCwd, ["commit", "-m", "feat: local work"]);
	command(root, ["merge", "--ff-only", "feat/local"]);
	assert.equal((await prepareBranchCleanup(plan.manifest)).mainRoot, fs.realpathSync(root));
});

test("cleanup refuses to delete a branch advanced after verification", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir, "feat/race");
	command(root, ["merge", "--ff-only", "feat/race"]);
	const { mainRoot, branchSha } = await prepareBranchCleanup(plan.manifest);
	fs.writeFileSync(path.join(plan.childCwd, "late.txt"), "new\n");
	command(plan.childCwd, ["add", "late.txt"]);
	command(plan.childCwd, ["commit", "-m", "feat: later work"]);
	const sessionFile = path.join(agentDir, "current.jsonl");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", cwd: plan.childCwd })}\n`);
	await assert.rejects(finishBranchCleanup(plan.manifest, sessionFile, mainRoot, branchSha), /moved during cleanup/);
	assert.equal(fs.existsSync(plan.childCwd), true);
});

test("refuses invalid, duplicate and dirty branch launches without changing the checkout", async () => {
	const { root, agentDir } = createRepo();
	await assert.rejects(createLaunchPlan(root, agentDir, "bad name"), /Invalid branch name/);
	await assert.rejects(createLaunchPlan(root, agentDir, "main"), /already exists/);
	fs.writeFileSync(path.join(root, "scratch.txt"), "experiment\n");
	await assert.rejects(createLaunchPlan(root, agentDir, "feat/experiment"), /clean checkout|Commit or remove/);
	assert.equal(command(root, ["branch", "--show-current"]), "main");
	assert.throws(() => command(root, ["rev-parse", "--verify", "refs/heads/feat/experiment"]));
});

test("creates a named branch from a clean checkout with ignored links", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), ".env\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore env"]);
	fs.writeFileSync(path.join(root, ".env"), "secret\n");
	const plan = await createLaunchPlan(root, agentDir, "feat/isolated");
	assert.equal(command(plan.childCwd, ["branch", "--show-current"]), "feat/isolated");
	assert.equal(command(root, ["branch", "--show-current"]), "main");
	assert.equal(fs.readlinkSync(path.join(plan.childCwd, ".env")), path.join(fs.realpathSync(root), ".env"));
	await releaseManagedWorktree(plan.manifest);
	assert.equal(command(root, ["rev-parse", "refs/heads/feat/isolated"]), command(root, ["rev-parse", "HEAD"]));
});

test("recovers clean worktrees after an abrupt exit without reclaiming live owners", async () => {
	const { root, agentDir } = createRepo();
	const stale = await createLaunchPlan(root, agentDir);
	const sessionDir = sessionDirectoryForCwd(stale.childCwd, agentDir);
	const sessionFile = path.join(sessionDir, "crashed.jsonl");
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "crashed", cwd: stale.childCwd })}\n`);
	const active = await createLaunchPlan(root, agentDir);
	stale.manifest.ownerPid = 99999999;
	await saveManifest(stale.manifest);
	assert.deepEqual(await reapStaleWorktrees(root), [stale.manifest.worktreeRoot]);
	assert.equal(fs.existsSync(stale.manifest.worktreeRoot), false);
	assert.ok(await loadResumeRecord(sessionFile));
	assert.equal(fs.existsSync(active.manifest.worktreeRoot), true);
});

test("reclaims legacy worktrees only after their transcript lease ends", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	const sessionFile = path.join(sessionDirectoryForCwd(plan.childCwd, agentDir), "legacy.jsonl");
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "legacy", cwd: plan.childCwd })}\n`);
	delete plan.manifest.ownerPid;
	plan.manifest.createdAt = "2020-01-01T00:00:00.000Z";
	await saveManifest(plan.manifest);
	fs.writeFileSync(`${sessionFile}.pi-worktree.lock`, JSON.stringify({ pid: process.pid }));
	assert.deepEqual(await reapStaleWorktrees(root), []);
	assert.equal(fs.existsSync(plan.childCwd), true);
	fs.unlinkSync(`${sessionFile}.pi-worktree.lock`);
	assert.deepEqual(await reapStaleWorktrees(root), [plan.manifest.worktreeRoot]);
	assert.ok(await loadResumeRecord(sessionFile));
});

test("recovers transcripts and refs left by an already removed worktree", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	const sessionFile = path.join(sessionDirectoryForCwd(plan.childCwd, agentDir), "orphaned.jsonl");
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "orphaned", cwd: plan.childCwd })}\n`);
	command(root, ["worktree", "unlock", plan.manifest.worktreeRoot]);
	command(root, ["worktree", "remove", "--force", plan.manifest.worktreeRoot]);
	plan.manifest.ownerPid = 99999999;
	await saveManifest(plan.manifest);
	assert.deepEqual(await reapStaleWorktrees(root), []);
	assert.equal(fs.existsSync(plan.manifest.manifestPath), false);
	const record = await loadResumeRecord(sessionFile);
	assert.ok(record);
	assert.equal(record.resumeSha, plan.manifest.publishedHead);
	assert.equal(await sessionCwd(sessionFile), record.placeholderCwd);
	const resumed = await createResumePlan(record);
	assert.equal(command(resumed.childCwd, ["rev-parse", "HEAD"]), record.resumeSha);
});

test("does not reclaim a crashed session with uncommitted work", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.childCwd, "unfinished.txt"), "keep\n");
	plan.manifest.ownerPid = 99999999;
	await saveManifest(plan.manifest);
	assert.deepEqual(await reapStaleWorktrees(root), []);
	assert.equal(fs.readFileSync(path.join(plan.childCwd, "unfinished.txt"), "utf8"), "keep\n");
});

test("checkpoints every legacy transcript that still references a released worktree", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	const sessionDir = sessionDirectoryForCwd(plan.childCwd, agentDir);
	const first = path.join(sessionDir, "first.jsonl");
	const second = path.join(sessionDir, "second.jsonl");
	fs.writeFileSync(first, `${JSON.stringify({ type: "session", id: "first", cwd: plan.childCwd })}\n`);
	fs.writeFileSync(second, `${JSON.stringify({ type: "session", id: "second", cwd: plan.childCwd })}\n`);

	const records = await checkpointWorktreeSessions(plan.manifest, first);

	assert.equal(records.length, 2);
	assert.notEqual(await sessionCwd(first), plan.childCwd);
	assert.notEqual(await sessionCwd(second), plan.childCwd);
	assert.ok(await loadResumeRecord(first));
	assert.ok(await loadResumeRecord(second));
});

test("allows an allocated session path before Pi creates its transcript", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	const sessionDir = sessionDirectoryForCwd(plan.childCwd, agentDir);
	const sessionFile = path.join(sessionDir, "not-created-yet.jsonl");

	const releaseLease = await acquireSessionLease(sessionFile);
	assert.equal(await checkpointSessionIfPresent(plan.manifest, sessionFile), null);
	assert.deepEqual(await checkpointWorktreeSessions(plan.manifest, sessionFile), []);
	await releaseLease();
	await releaseManagedWorktree(plan.manifest);
	assert.equal(fs.existsSync(plan.manifest.worktreeRoot), false);
});

test("serializes released-session activation and active transcript ownership", async () => {
	const { agentDir } = createRepo();
	const sessionFile = path.join(agentDir, "leased.jsonl");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "leased", cwd: agentDir })}\n`);

	const releaseClaim = await acquireResumeClaim(sessionFile);
	await assert.rejects(acquireResumeClaim(sessionFile), /already active/);
	await releaseClaim();
	const releaseReplacementClaim = await acquireResumeClaim(sessionFile);
	await releaseReplacementClaim();

	const releaseLease = await acquireSessionLease(sessionFile);
	await assert.rejects(acquireSessionLease(sessionFile), /already active/);
	await releaseLease();
});


test(
	"profile child retains supervisor IPC after the readiness handshake",
	{ timeout: 15000 },
	async () => {
		const extension = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
		const loader = path.join(
			path.dirname(fileURLToPath(import.meta.url)),
			"..",
			"_outliner",
			"package.json",
		);
		const script = `const {createRequire}=await import('node:module');const require=createRequire(${JSON.stringify(loader)});const {createJiti}=require('jiti');const {signalChildReady}=await createJiti(import.meta.url).import(${JSON.stringify(extension)},{default:false});await signalChildReady();if(!process.connected)throw new Error('Supervisor channel was closed');process.send('followup-ready',()=>process.disconnect());`;
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
			env: { ...process.env, PI_PROFILE_RELOAD_TOKEN: "proof" },
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		let followup = false;
		let errors = "";
		child.stderr!.on("data", (data) => {
			errors += data;
		});
		child.on("message", (message) => {
			if (message === "pi-worktree-session-ready") child.send("pi-worktree-parent-yielded");
			if (message === "followup-ready") followup = true;
		});
		try {
			const code = await new Promise((resolve, reject) => {
				child.on("error", reject);
				child.on("close", resolve);
			});
			assert.equal(code, 0, errors);
			assert(followup);
		} finally {
			if (child.exitCode === null) child.kill();
		}
	},
);
