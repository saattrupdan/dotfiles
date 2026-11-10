import { dispatchAsk } from "../question/index.ts";
import { remotePromptsEnabled } from "../_remote_bridge/prompts.ts";
import { clearRemoteCommands } from "../_remote_bridge/commands.ts";
import { markGuard, clearGuards } from "../_remote_bridge/guards.ts";
/** Protect native history before runtime switches; preserve familiar /resume. */
import path from "node:path";
import fs from "node:fs";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	acquire,
	ownedRecord,
	release,
	releaseNamespace,
	reserveNamespace,
	inspect,
	historyInScope,
} from "../_session_ownership/ownership.mjs";
import { withOwnedTransition, type OwnershipState } from "../_session_ownership/transition.ts";
import { OwnedEditor } from "../_session_ownership/editor.ts";
import { interactiveQueue } from "../_interactive_queue/queue.ts";
import { listSavedSessions } from "../../profile/saved-sessions.mjs";
import { localAction } from "../_remote_bridge/local.ts";
import { isLoopActive } from "../_loop_state/state.ts";
type State = OwnershipState;
const globalState = globalThis as typeof globalThis & { __piSessionOwnership?: State };
export default function (pi: ExtensionAPI) {
	if (!process.env.PI_SESSION_OWNER || process.env.PI_SUBAGENT_CHILD === "1") return;
	const inherited = ownedRecord();
	if (!inherited) throw new Error("Pi ownership missing");
	const state = (globalState.__piSessionOwnership ??= { ...inherited, files: new Set() });
	pi.on("session_start", (_event, ctx) => {
		try {
			const file = ctx.sessionManager.getSessionFile();
			if (file) {
				acquire(file, state.owner, state.root, ctx.sessionManager.getSessionId());
				state.files.add(file);
			}
			state.context = ctx;
			state.current = file;
			if (state.transition) state.transition.started = true;
			else {
				for (const previous of state.files)
					if (previous !== file) {
						release(previous, state.owner, state.root);
						state.files.delete(previous);
					}
				releaseNamespace(state.owner, state.root);
			}
			if (ctx.mode === "tui" && !ctx.ui.getEditorComponent())
				ctx.ui.setEditorComponent((tui, theme, keys) => new OwnedEditor(tui, theme, keys));
		} catch (error) {
			ctx.ui.notify(`Ownership protection failed: ${String(error)}`, "error");
			ctx.shutdown();
		}
	});
	pi.on("session_before_switch", (event, ctx) => {
		try {
			if (!state.transition)
				throw new Error("Use the ownership-aware /new, /resume or /fork command");
			if (event.targetSessionFile) {
				const target = path.resolve(event.targetSessionFile);
				if (!fs.existsSync(target))
					throw new Error(
						"Import into a new saved path requires an ownership-aware import adapter",
					);
				const privateRoot = path.resolve(
					process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME!, ".pi", "agent"),
					"profile-sessions",
				);
				if (target === privateRoot || target.startsWith(privateRoot + path.sep))
					throw new Error("Private profiles cannot be resumed in main");
				acquire(target, state.owner, state.root);
				state.files.add(target);
			} else reserveNamespace(state.owner, state.root);
		} catch (error) {
			ctx.ui.notify(`Resume blocked: ${String(error)}`, "error");
			return { cancel: true };
		}
	});
	pi.on("session_before_fork", (_event, ctx) => {
		try {
			if (!state.transition) throw new Error("Use ownership-aware /fork");
			reserveNamespace(state.owner, state.root);
		} catch (error) {
			ctx.ui.notify(String(error), "error");
			return { cancel: true };
		}
	});
	pi.on("session_shutdown", () => {
		clearGuards();
		clearRemoteCommands();
		if (state.transition) state.transition.shutdown = true;
	});
	// Source locks survive all shutdown handlers, reloads and process teardown. A new
	// session_start releases old files only after the old runtime has finished writing.
	pi.registerCommand("pi-owned-new", {
		description: "Start a new exclusively owned session",
		handler: async (_args, ctx) => {
			if (isLoopActive()) throw new Error("Stop /loop before starting a new conversation");
			await ctx.waitForIdle();
			await withOwnedTransition(() => ctx.newSession());
		},
	});
	pi.registerCommand("pi-owned-fork", {
		description: "Fork with exclusive native-history ownership",
		handler: async (query, ctx) => {
			if (isLoopActive()) throw new Error("Stop /loop before forking");
			await ctx.waitForIdle();
			const entries = ctx.sessionManager
				.getEntries()
				.filter((e) => e.type === "message" && e.message.role === "user");
			const labels = entries.map(
				(e) =>
					`${e.id}: ${e.type === "message" && e.message.role === "user" ? JSON.stringify(e.message.content).slice(0, 100) : ""}`,
			);
			const selected = query.trim() || (await choose(ctx, "Fork before user message", labels));
			if (!selected) return;
			const entry = entries.find((e) => e.id === selected || selected.startsWith(e.id + ":"));
			if (!entry) throw new Error("Unknown fork entry");
			await withOwnedTransition(() =>
				ctx.fork(entry.id, {
					withSession: async (next) => {
						ctx = next;
					},
				}),
			);
		},
	});
	pi.registerCommand("pi-owned-resume", {
		description: "Resume with exclusive session ownership",
		handler: async (query, ctx) => resume(query, ctx, state),
	});

	markGuard("session-ownership");
}
async function resume(query: string, ctx: ExtensionCommandContext, state: State) {
	try {
		if (isLoopActive()) {
			ctx.ui.notify("Stop /loop explicitly before switching conversations.", "warning");
			return;
		}
		await ctx.waitForIdle();
		const sessions = listSavedSessions({
			agentDir: process.env.PI_CODING_AGENT_DIR,
			sessionDir: ctx.sessionManager.getSessionDir(),
			scope: process.env.PI_SESSION_HISTORY_SCOPE,
		})
			.filter(
				(s) =>
					historyInScope(s.path) &&
					s.path !== state.current &&
					(!query || `${s.name ?? ""} ${s.firstMessage} ${s.cwd} ${s.id}`.toLowerCase().includes(query.toLowerCase())),
			)
			.sort((a, b) => +b.modified - +a.modified);
		if (!sessions.length) {
			ctx.ui.notify("No matching saved conversations.", "info");
			return;
		}
		const labels = sessions.map(
			(s) => `${s.name || s.firstMessage.slice(0, 70) || s.id} [${s.cwd}] (${s.id.slice(0, 8)})`,
		);
		const selected = await choose(ctx, "Resume conversation", labels);
		if (!selected) return;
		const destination = sessions[labels.indexOf(selected)]!;
		const holder = inspect(destination.path, state.root);
		if (holder && holder.instanceId !== state.owner.instanceId) {
			const yes = await choose(
				ctx,
				`Transfer conversation from Pi process ${holder.pid}? Let its current work finish, then transfer it here.`,
				["Transfer", "Cancel"],
			);
			if (yes !== "Transfer") return;

			ctx.ui.setWorkingMessage("Waiting for Pi to finish and release the conversation...");
			const outcome = (await localAction("handoff", {
				sessionId: destination.id,
				expectedOwner: holder.instanceId,
			})) as { status?: string };
			if (outcome.status === "rejected") throw new Error("Source owner refused the transfer");
			for (;;) {
				ctx.sessionManager.getSessionId();
				const current = inspect(destination.path, state.root);
				if (!current) break;
				if (current.instanceId !== holder.instanceId)
					throw new Error("Conversation owner changed; choose it again to offer a new transfer");
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		}
		acquire(destination.path, state.owner, state.root);
		state.files.add(destination.path);
		try {
			await withOwnedTransition(() =>
				ctx.switchSession(destination.path, {
					withSession: async (next) => {
						ctx = next;
					},
				}),
			);
		} finally {
			if (state.current !== destination.path) {
				release(destination.path, state.owner, state.root);
				state.files.delete(destination.path);
			}
		}
	} catch (error) {
		try {
			ctx.ui.notify(`Resume failed: ${String(error)}`, "error");
		} catch {
			/* Replacement invalidated the old local command. */
		}
	} finally {
		try {
			ctx.ui.setWorkingMessage();
		} catch {
			/* Old context is no longer active. */
		}
	}
}

async function choose(
	ctx: ExtensionCommandContext,
	title: string,
	options: string[],
): Promise<string | undefined> {
	if (!remotePromptsEnabled())
		return interactiveQueue.run((signal) => ctx.ui.select(title, options, { signal }));
	const outcome = await dispatchAsk(ctx, [{ question: title, options }], undefined);
	if (outcome.error === "dismissed") return undefined;
	if (outcome.error) throw new Error(outcome.error);
	const answer = outcome.answers?.[0];
	return options.includes(answer || "") ? answer : undefined;
}
