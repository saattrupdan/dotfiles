import { SubagentProgress } from "../_remote_bridge/progress.ts";
import { expandCommandInput, isInputCommand } from "../_remote_bridge/command-input.ts";
import {
	hasRemoteCommand,
	invokeRemoteCommand,
	clearRemoteCommands,
} from "../_remote_bridge/commands.ts";
/** Control the existing main-profile process over authenticated local IPC. */
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NativeEnvelope, type CommandStatus } from "../../remote/packages/protocol/src/index.ts";
import { dataDirectory } from "../_remote_bridge/local.ts";
import { currentPrompt, configurePrompts, respondPrompt } from "../_remote_bridge/prompts.ts";
import { missingGuards, clearGuards } from "../_remote_bridge/guards.ts";
import { isIncognito, incognitoRequested } from "../_incognito_state/state.ts";
import { currentLoopCompletion, isLoopActive, onLoopCompletion, suspendLoopForHandoff } from "../_loop_state/state.ts";

const MARKER = /<!-- pi-remote-command:([0-9a-f-]{36}) -->/;

const required = ["file-protection", "caffeinate", "question", "conversation-name", "incognito"];
type Journal = Record<string, { fingerprint: string; status: CommandStatus }>;
export default function (pi: ExtensionAPI) {
	if (
		process.env.PI_SUBAGENT_CHILD === "1" ||
		process.argv.includes("-p") ||
		process.argv.includes("--print")
	)
		return;
	const processState = globalThis as typeof globalThis & { __piRemoteInstance?: string };
	const instanceId = (processState.__piRemoteInstance ??= randomUUID());
	let ctx: ExtensionContext;
	let socket: net.Socket | undefined;
	let reconnect: ReturnType<typeof setTimeout> | undefined;
	const inFlight = new Set<string>();
	let operations = 0;
	let queued = 0;
	let commands = Promise.resolve();
	let epoch = 0;
	let stopped = false;
	let stopping = false;
	let settled = true;
	let loopIteration = false;
	let retries = 0;
	let registered = false;
	let privateSession = "";
	const dir = dataDirectory();
	const journalDir = path.join(dir, "commands");
	fs.mkdirSync(journalDir, { recursive: true, mode: 0o700 });
	const journalFile = path.join(journalDir, `${instanceId}.json`);
	const journalRoot = globalThis as typeof globalThis & {
		__piRemoteJournals?: Map<string, Journal>;
	};
	const journals = (journalRoot.__piRemoteJournals ??= new Map<string, Journal>());
	let journal: Journal = journals.get(instanceId) ?? {};
	if (!journals.has(instanceId)) {
		try {
			journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				throw new Error("Remote delivery journal cannot be read safely", { cause: error });
		}
		journals.set(instanceId, journal);
	}
	const save = () => {
		const temp = journalFile + ".tmp";
		fs.writeFileSync(temp, JSON.stringify(journal), { mode: 0o600 });
		fs.renameSync(temp, journalFile);
	};
	let resync = false;
	const send = (data: unknown) => {
		if (!socket || socket.destroyed) return;
		if (socket.writableLength > 16 * 1024 * 1024) {
			resync = true;
			return;
		}
		let line = JSON.stringify(data) + "\n";
		if (Buffer.byteLength(line) > 16 * 1024 * 1024)
			line = JSON.stringify({ type: "event", kind: "resnapshot", data: null }) + "\n";
		socket.write(line);
	};
	const visible = () =>
		Boolean(
			ctx &&
			!isIncognito(ctx.sessionManager) &&
			!incognitoRequested() &&
			ctx.sessionManager.getSessionFile(),
		);
	const event = (kind: string, data: unknown) => {
		if (visible() && registered) send({ type: "event", kind, data });
	};
	const publishLoopCompletion = () => {
		const completion = currentLoopCompletion();
		if (!stopped && ctx && completion?.sessionId === ctx.sessionManager.getSessionId())
			event("loop_completed", { id: completion.id, outcome: completion.outcome });
	};
	const unsubscribeCompletion = onLoopCompletion("remote-control", publishLoopCompletion);
	const progress = new SubagentProgress((block) => event("tool_progress", block));
	const ack = (id: string, status: CommandStatus, error?: string) => {
		if (journal[id]?.status === "persisted") {
			status = "persisted";
			error = undefined;
		}
		if (status === "persisted" || status === "rejected") inFlight.delete(id);
		if (journal[id]) {
			journal[id]!.status = status;
			save();
		}
		send({ type: "ack", commandId: id, status, error });
	};
	const capabilities = () => {
		const result = pi.getCommands().map((c) => ({
			name: c.name,
			supported: hasRemoteCommand(c.name) || isInputCommand(c),
			reason:
				hasRemoteCommand(c.name) || isInputCommand(c)
					? undefined
					: c.name === "incognito"
						? "Incognito sessions are local-only"
						: "No remote adapter; use the local terminal",
		}));
		for (const name of [
			"resume",
			"new",
			"fork",
			"import",
			"export",
			"reload",
			"login",
			"logout",
			"settings",
			"model",
			"thinking",
			"name",
			"compact",
			"copy",
			"share",
			"session",
			"help",
		])
			if (!result.some((c) => c.name === name))
				result.push({
					name,
					supported: false,
					reason: ["model", "thinking", "name", "compact", "new", "resume"].includes(name)
						? "Use the dedicated Pi Remote control"
						: "Requires local terminal interaction",
				});
		return result;
	};
	const register = () => {
		registered = false;
		if (!visible()) {
			if (
				ctx && isIncognito(ctx.sessionManager) &&
				privateSession !== ctx.sessionManager.getSessionId()
			) {
				privateSession = ctx.sessionManager.getSessionId();
				send({ type: "private", sessionId: privateSession });
			}
			return;
		}
		privateSession = "";
		const missing = missingGuards(required);
		if (missing.length) {
			ctx.ui.setStatus("remote-control", `Remote disabled: missing ${missing.join(", ")}`);
			return;
		}
		send({
			type: "register",
			data: {
				version: 1,
				instanceId: instanceId,
				sessionId: ctx.sessionManager.getSessionId(),
				nativeSessionEnvelope: 1,
				sessionFile: ctx.sessionManager.getSessionFile(),
				cwd: ctx.cwd,
				name: pi.getSessionName() ?? "Untitled",
				pid: process.pid,
				managed: Boolean(process.env.PI_REMOTE_MANAGED),
				tmux: process.env.PI_REMOTE_MANAGED,
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "",
				thinking: pi.getThinkingLevel(),
				capabilities: capabilities(),
				idle: ctx.isIdle() && settled,
				loop: isLoopActive(),
				prompt: currentPrompt(),
			},
		});
	};
	const persisted = () => {
		const file = ctx.sessionManager.getSessionFile();
		if (!file || !fs.existsSync(file)) return;
		// Native history contains a unique marker in the normal user input. Matching
		// plain text alone would confuse identical concurrent local and phone messages.
		const entries = ctx.sessionManager.getEntries();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const content = entry.message.content;
			const text =
				typeof content === "string"
					? content
					: content
							.filter((p) => p.type === "text")
							.map((p) => p.text)
							.join("\n");
			const match = MARKER.exec(text);
			if (match && journal[match[1]!]?.status !== "persisted") {
				const disk = fs.readFileSync(file, "utf8");
				if (disk.includes(match[0])) ack(match[1]!, "persisted");
			}
		}
	};
	const expire = (prompt: { id: string; title: string }) => {
		suspendLoopForHandoff();
		pi.sendMessage(
			{
				customType: "remote:answer-needed",
				content: `Answer needed: ${prompt.title}`,
				display: true,
				details: { promptId: prompt.id },
			},
			{ triggerTurn: false },
		);
		ctx.abort();
		event("prompt.expired", { id: prompt.id, title: prompt.title });
	};
	const drain = () => {
		if (
			stopping &&
			queued === 0 &&
			operations === 0 &&
			inFlight.size === 0 &&
			settled &&
			ctx.isIdle() &&
			!ctx.hasPendingMessages() &&
			!isLoopActive() &&
			!currentPrompt()
		)
			ctx.shutdown();
	};
	const inject = async (id: string, input: string, images: unknown = []) => {
		if (!ctx.model) throw new Error("no_model_selected");
		if (!(await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)).ok)
			throw new Error("model_authentication_missing");
		if (stopped || !visible()) throw new Error("session_changed");
		const text = `<!-- pi-remote-command:${id} -->\n${input}`;
		const parsedImages = Array.isArray(images)
			? images.filter((p): p is { type: "image"; data: string; mimeType: string } =>
					Boolean(p && typeof p === "object" && (p as { type: string }).type === "image"),
				)
			: [];
		inFlight.add(id);
		pi.sendUserMessage([{ type: "text", text }, ...parsedImages], {
			deliverAs: "steer",
			expandPromptTemplates: false,
		});
	};
	const dispatch = async (raw: unknown, images: unknown) => {
		const envelope = NativeEnvelope.parse(raw);
		const id = envelope.commandId;
		if (!visible() || envelope.sessionId !== ctx.sessionManager.getSessionId()) {
			send({ type: "ack", commandId: id, status: "rejected", error: "not_owner" });
			return;
		}
		if (envelope.epoch !== epoch) {
			send({ type: "ack", commandId: id, status: "rejected", error: "stale_epoch" });
			return;
		}
		const fingerprint = createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
		if (journal[id]) {
			if (journal[id]!.fingerprint !== fingerprint) {
				send({ type: "ack", commandId: id, status: "rejected", error: "command_id_conflict" });
				return;
			}
			persisted();
			send({ type: "ack", commandId: id, status: journal[id]!.status });
			return;
		}
		journal[id] = { fingerprint, status: "delivery_unknown" };
		save();
		const command = envelope.command;
		if (stopping && !["stop_run", "answer"].includes(command.action)) {
			ack(id, "rejected", "session_stopping");
			return;
		}
		operations++;
		try {
			switch (command.action) {
				case "message":
					await inject(id, command.text, images);
					break;
				case "stop_run":
					suspendLoopForHandoff();
					ctx.abort();
					ack(id, "accepted_by_owner");
					break;
				case "stop_session":
					suspendLoopForHandoff();
					stopping = true;
					ack(id, "accepted_by_owner");
					drain();
					break;
				case "answer":
					respondPrompt(command.promptId, command.answer);
					ack(id, "accepted_by_owner");
					break;
				case "rename":
					pi.setSessionName(command.name);
					ack(id, "persisted");
					register();
					break;
				case "thinking":
					pi.setThinkingLevel(command.level);
					ack(id, "persisted");
					register();
					break;
				case "model": {
					const model = ctx.modelRegistry.find(command.provider, command.model);
					if (!model || !(await pi.setModel(model))) throw new Error("unsupported_model");
					ack(id, "persisted");
					register();
					break;
				}
				case "compact":
					if (!ctx.isIdle() || !settled) throw new Error("agent_busy");
					ctx.compact({
						onComplete: () => {
							ack(id, "persisted");
							event("snapshot", ctx.sessionManager.buildSessionProjection().messages);
						},
						onError: () => ack(id, "rejected", "compact_failed"),
					});
					ack(id, "accepted_by_owner");
					break;
				case "slash":
					if (!hasRemoteCommand(command.name)) {
						const input = await expandCommandInput(pi, ctx, command.name, command.args);
						if (input === undefined) throw new Error("unsupported_command");
						await inject(id, input);
						break;
					}
					if (
						["fast", "allow-long-context"].includes(command.name) &&
						!["", "off"].includes(command.args.trim())
					)
						throw new Error("invalid_command_arguments");
					if (
						command.name === "fast" &&
						command.args.trim() !== "off" &&
						ctx.model?.provider !== "openai-codex"
					)
						throw new Error("unsupported_model");
					if (
						command.name === "caffeinate" &&
						!["", "on", "off", "status"].includes(command.args.trim())
					)
						throw new Error("invalid_command_arguments");
					await invokeRemoteCommand(command.name, command.args, ctx);
					ack(id, "accepted_by_owner");
					break;
			}
		} catch (error) {
			ack(
				id,
				stopped ? "delivery_unknown" : "rejected",
				error instanceof Error ? error.message : "command_failed",
			);
		} finally {
			operations--;
			if (!stopped) drain();
		}
	};
	const connect = () => {
		if (stopped) return;
		let buffer = "";
		const next = net.connect(path.join(dir, "broker.sock"));
		socket = next;
		next.setEncoding("utf8");
		next.on("connect", () => {
			try {
				send({ secret: fs.readFileSync(path.join(dir, "ipc.key"), "utf8").trim() });
			} catch {
				next.destroy();
			}
		});
		next.on("data", (chunk) => {
			buffer += chunk;
			if (buffer.length > 20 * 1024 * 1024) {
				next.destroy();
				return;
			}
			let index: number;
			while ((index = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				try {
					const value = JSON.parse(line);
					if (value.type === "ready") {
						retries = 0;
						privateSession = "";
						register();
					}
					if (value.type === "registered") {
						epoch = value.epoch;
						registered = true;
						ctx.ui.setStatus("remote-control", undefined);
						persisted();
						for (const [id, entry] of Object.entries(journal))
							send({ type: "ack", commandId: id, status: entry.status });
						event("snapshot", ctx.sessionManager.buildSessionProjection().messages);
						progress.replay();
						publishLoopCompletion();
					}
					if (value.type === "command") {
						queued++;
						commands = commands
							.then(() => dispatch(value.envelope, value.images))
							.catch(() => {
								next.destroy();
							})
							.finally(() => {
								queued--;
								if (!stopped) drain();
							});
					}
				} catch {
					next.destroy();
				}
			}
		});
		next.on("drain", () => {
			if (resync && !stopped) {
				resync = false;
				event("resnapshot", null);
				for (const [id, entry] of Object.entries(journal))
					send({ type: "ack", commandId: id, status: entry.status });
			}
		});
		next.on("error", () => {});
		next.on("close", () => {
			registered = false;
			if (!stopped) {
				reconnect = setTimeout(
					connect,
					Math.min(30000, 500 * 2 ** Math.min(retries++, 6)) + Math.random() * 300,
				);
				reconnect.unref();
			}
		});
	};
	const heartbeat = setInterval(() => {
		if (!ctx) return;
		if (!visible()) {
			progress.clear();
			if (registered) {
				send({ type: "unregister" });
				registered = false;
			}
			register();
			return;
		}
		if (socket && !socket.destroyed && !registered) register();
		if (registered)
			send({
				type: "heartbeat",
				data: { idle: ctx.isIdle() && settled, loop: isLoopActive(), prompt: currentPrompt() },
			});
		drain();
	}, 5000);
	heartbeat.unref();
	pi.on("session_start", (_e, next) => {
		ctx = next;
		settled = true;
		loopIteration = isLoopActive();
		progress.clear();
		configurePrompts({ publish: (prompt) => event("prompt", prompt), expire });
		if (!socket) connect();
		else register();
	});
	pi.on("session_before_switch", () => {
		if (operations || inFlight.size) return { cancel: true };
		progress.clear();
		if (registered) {
			send({ type: "unregister" });
			registered = false;
		}
	});
	pi.on("session_before_fork", () => {
		if (operations || inFlight.size) return { cancel: true };
		progress.clear();
		if (registered) {
			send({ type: "unregister" });
			registered = false;
		}
	});
	pi.on("input", (event) => {
		if (!visible()) return;
		if (stopping && event.source !== "extension") return { action: "handled" };
		// Input observation precedes native model/auth validation; it is not acceptance.
	});
	pi.on("agent_start", (_e, next) => {
		ctx = next;
		settled = false;
		loopIteration = isLoopActive();
		progress.clear();
		event("agent_start", null);
	});
	pi.on("agent_settled", (_e, next) => {
		ctx = next;
		settled = true;
		progress.clear();
		persisted();
		event("agent_settled", { loopIteration });
		event("snapshot", next.sessionManager.buildSessionProjection().messages);
		drain();
	});
	pi.events.on("thinking-status:override", (data) => {
		const label =
			data && typeof data === "object" ? (data as { label?: unknown }).label : undefined;
		event("working_override", { label: typeof label === "string" ? label : null });
	});
	pi.on("message_update", (eventData) => event("message_update", eventData.message));
	pi.on("message_end", (eventData) => {
		event("message_end", eventData.message);
		setImmediate(() => {
			if (!stopped && ctx && visible()) persisted();
		});
	});
	pi.on("tool_execution_start", (e) =>
		event("tool_execution_start", { toolCallId: e.toolCallId, name: e.toolName }),
	);
	pi.on("tool_execution_update", (e) => {
		if (e.toolName !== "subagent") return;
		if (!visible()) {
			progress.clear();
			return;
		}
		progress.update(e.toolCallId, e.args, e.partialResult, ctx.ui.theme);
	});
	pi.on("tool_execution_end", (e) => {
		progress.end(e.toolCallId);
		event("tool_execution_end", { toolCallId: e.toolCallId, name: e.toolName, isError: e.isError });
	});
	pi.on("session_tree", (_e, next) => {
		ctx = next;
		event("snapshot", next.sessionManager.buildSessionProjection().messages);
	});
	pi.on("session_compact", (_e, next) => {
		ctx = next;
		event("snapshot", next.sessionManager.buildSessionProjection().messages);
	});
	pi.on("model_select", (_e, next) => {
		ctx = next;
		register();
	});
	pi.on("thinking_level_select", (_e, next) => {
		ctx = next;
		register();
	});
	pi.on("session_info_changed", (e) => event("session_info_changed", e));
	pi.on("session_shutdown", () => {
		stopped = true;
		unsubscribeCompletion();
		progress.clear();
		clearGuards();
		clearRemoteCommands();
		clearInterval(heartbeat);
		if (reconnect) clearTimeout(reconnect);
		configurePrompts();
		socket?.destroy();
		ctx?.ui.setStatus("remote-control", undefined);
	});
}
