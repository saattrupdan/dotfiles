/**
 * `memory-async` — run memory writes in the background.
 *
 * Understory's `memory_add` / `memory_update` spawn a librarian agent, and that
 * agent is slow: from Understory's own trace log the median mutation is ~17s,
 * p90 ~21s, and the worst observed run was 842s. Pi awaits every tool result,
 * so a write stalls the conversation for its whole duration — and a run longer
 * than `requestTimeoutMs` in mcp.json even surfaces as a client-side timeout
 * while Understory keeps writing behind it.
 *
 * This extension replaces those two MCP direct tools with same-named wrappers
 * that validate the arguments, append a job to a persistent FIFO queue under
 * `~/.pi/agent/memory-async/`, wake `worker.mjs` (detached, single instance),
 * and return in milliseconds. `memory_query` deliberately stays synchronous —
 * a read that skipped the queue would be meaningless.
 *
 * Two things are lost and are handled explicitly:
 *   - The model no longer learns whether the write landed. The ack reports the
 *     job id and any backlog, and warns when past writes failed permanently.
 *   - `/memory-queue` shows the queue and log, and can requeue failures.
 *
 * A third, purely visual, consequence: these tools are no longer MCP direct
 * tools, so `mcp-collapse` (which owns pi-mcp-adapter and restyles its tools)
 * no longer reaches them. Without renderers pi prints the whole argument JSON,
 * which is the paragraph of knowledge being saved. Hence the `renderCall` /
 * `renderResult` pair below — collapsed to one line, expanded with Ctrl+O.
 *
 * Requires `memory_add`/`memory_update` to be removed from the understory
 * `directTools` list in mcp.json, otherwise two tools share the name.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type {
	AgentToolResult,
	ExtensionAPI,
	Theme,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const ROOT = process.env.MEMORY_ASYNC_DIR ?? path.join(os.homedir(), ".pi", "agent", "memory-async");
const QUEUE_DIR = path.join(ROOT, "queue");
const DONE_DIR = path.join(ROOT, "done");
const FAILED_DIR = path.join(ROOT, "failed");
const LOG_FILE = path.join(ROOT, "worker.log");
const PID_FILE = path.join(ROOT, "worker.pid");
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.mjs");

const AddParams = Type.Object({
	content: Type.String({ description: "The knowledge to record, in any prose form" }),
	suggested_path: Type.Optional(
		Type.String({ description: 'Optional bundle path hint, e.g. "/apis/payments.md"' }),
	),
});

const UpdateParams = Type.Object({
	instruction: Type.String({ description: "What to change, in natural language" }),
});

function listDir(dir: string): string[] {
	try {
		return fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
	} catch {
		return [];
	}
}

function workerIsAlive(): boolean {
	let pid: number;
	try {
		pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10) || 0;
	} catch {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Start the drain worker unless one already owns the queue. Never blocks. */
function ensureWorker(): void {
	if (workerIsAlive()) return;
	try {
		const child = spawn(process.execPath, [WORKER], {
			stdio: "ignore",
			detached: true,
			env: { ...process.env },
		});
		child.unref();
	} catch {
		// The job is on disk; the next enqueue or agent_end will retry.
	}
}

/** Append one job and return its id. FIFO order follows the zero-padded timestamp. */
function enqueue(tool: string, args: Record<string, unknown>): string {
	fs.mkdirSync(QUEUE_DIR, { recursive: true });
	const id = `${String(Date.now()).padStart(14, "0")}-${process.pid}-${Math.random()
		.toString(16)
		.slice(2, 6)}`;
	const tmp = path.join(QUEUE_DIR, `${id}.json.tmp`);
	fs.writeFileSync(tmp, JSON.stringify({ tool, arguments: args, queuedAt: new Date().toISOString() }), "utf-8");
	fs.renameSync(tmp, path.join(QUEUE_DIR, `${id}.json`));
	return id;
}

function tailLog(lines: number): string[] {
	try {
		return fs
			.readFileSync(LOG_FILE, "utf-8")
			.trim()
			.split("\n")
			.slice(-lines)
			.filter(Boolean);
	} catch {
		return [];
	}
}

function queueSummary(): { pending: number; ahead: number; failed: number; failedNote: string } {
	const pending = listDir(QUEUE_DIR).length;
	const failed = listDir(FAILED_DIR).length;
	const failedNote = failed
		? ` WARNING: ${failed} background write(s) previously failed permanently — run /memory-queue retry.`
		: "";
	return { pending, ahead: Math.max(0, pending - 1), failed, failedNote };
}

/**
 * Collapsed-view summaries. The two tools used to be MCP direct tools, which
 * `mcp-collapse` rendered as a single "✓ Stored a memory" line; now that this
 * extension owns them it must provide the renderers itself, or pi falls back to
 * its default view — tool name, the *entire* argument JSON (i.e. the whole
 * paragraph of knowledge), and the raw ack.
 *
 * Wording says "queued", not "stored": the write has not happened yet, and a
 * green "✓ Stored" would be a lie about a deferred action.
 */
const COLLAPSED_SUMMARY: Record<string, string> = {
	memory_add: "Queued a memory write",
	memory_update: "Queued a memory update",
};

function resultText(result: AgentToolResult<unknown>): string {
	return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

/** Display-only renderers: the model always sees the full ack, Ctrl+O shows it. */
function renderQueuedCall(name: string, args: Record<string, unknown>, theme: Theme, expanded: boolean): Component {
	const title = theme.fg("toolTitle", theme.bold(name));
	if (!expanded || !args || Object.keys(args).length === 0) {
		return new Text(title, 0, 0);
	}
	return new Text(`${title}\n${theme.fg("muted", JSON.stringify(args, null, 2))}`, 0, 0);
}

function renderQueuedResult(
	name: string,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	isError: boolean,
): Component {
	if (options.isPartial) {
		return new Text(theme.fg("warning", "…"), 0, 0);
	}
	if (options.expanded || isError) {
		const paint = (line: string) => theme.fg(isError ? "error" : "toolOutput", line);
		return new Text(resultText(result).split("\n").map(paint).join("\n"), 0, 0);
	}
	return new Text(theme.fg("success", `✓ ${COLLAPSED_SUMMARY[name] ?? "Queued a memory write"}`), 0, 0);
}

function registerWriteTool(
	pi: ExtensionAPI,
	name: string,
	description: string,
	parameters: typeof AddParams | typeof UpdateParams,
	argsOf: (params: { content?: string; suggested_path?: string; instruction?: string }) => Record<string, unknown>,
) {
	pi.registerTool({
		name,
		label: name,
		description,
		promptSnippet:
			"Queue a memory write and return immediately; the write is applied in the background by a detached worker.",
		promptGuidelines: [
			"memory_add and memory_update return as soon as the write is queued — do not re-call them to confirm, and do not wait for the write to land before finishing your reply.",
			"Name the entity the knowledge belongs to (e.g. \"Dan prefers X\", not \"prefers X\") so the background librarian can attach it to the right concept; the write happens later, so you cannot correct it in this turn.",
			"Use /memory-queue to inspect or requeue background writes if a write matters.",
		],
		parameters,

		async execute(_toolCallId, params) {
			const args = argsOf(params as Record<string, unknown>);
			let id: string;
			try {
				id = enqueue(name, args);
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Could not queue ${name}: ${String((err as Error)?.message ?? err)}. The knowledge was NOT recorded — fall back to reporting it to the user.`,
						},
					],
					isError: true,
					details: undefined,
				};
			}
			ensureWorker();
			const { ahead, failedNote } = queueSummary();
			const backlog = ahead > 0 ? ` ${ahead} earlier write(s) are ahead of it in the queue.` : "";
			return {
				content: [
					{
						type: "text",
						text:
							`Queued ${name} as background job ${id}.${backlog}${failedNote}\n` +
							"The write is applied by the background worker; nothing further is needed from this turn.",
					},
				],
				details: undefined,
			};
		},

		renderCall: (args, theme, ctx) => renderQueuedCall(name, args as Record<string, unknown>, theme, ctx.expanded),

		renderResult: (result, options, theme, ctx) =>
			renderQueuedResult(name, result as AgentToolResult<unknown>, options, theme, ctx.isError),
	});
}

export default function (pi: ExtensionAPI) {
	registerWriteTool(
		pi,
		"memory_add",
		"Provide free-form knowledge (facts, docs, decisions, runbooks). Queues the write and returns immediately; " +
			"a background librarian agent then searches for overlap and creates or extends OKF concepts, keeping the " +
			"indexes and the update log current.",
		AddParams,
		(p) => (p.suggested_path ? { content: p.content, suggested_path: p.suggested_path } : { content: p.content }),
	);

	registerWriteTool(
		pi,
		"memory_update",
		"Instruct a change to existing knowledge (correct a fact, deprecate a concept, restructure). Queues the change " +
			"and returns immediately; a background librarian agent locates the concepts and applies targeted edits.",
		UpdateParams,
		(p) => ({ instruction: p.instruction }),
	);

	// Leftovers from a session that ended mid-write get drained here rather
	// than waiting for the next write to wake the worker.
	pi.on("agent_end", () => {
		if (listDir(QUEUE_DIR).length > 0) ensureWorker();
	});

	pi.registerCommand("memory-queue", {
		description: "Show background memory writes (status | retry | drop)",
		handler: async (args, ctx) => {
			const sub = args[0] ?? "status";
			const queued = listDir(QUEUE_DIR);
			const done = listDir(DONE_DIR);
			const failed = listDir(FAILED_DIR);

			if (sub === "retry") {
				let n = 0;
				for (const name of failed) {
					try {
						const file = path.join(FAILED_DIR, name);
						const job = JSON.parse(fs.readFileSync(file, "utf-8"));
						delete job.error;
						fs.writeFileSync(path.join(QUEUE_DIR, name), JSON.stringify(job), "utf-8");
						fs.unlinkSync(file);
						n++;
					} catch { /* leave it failed */ }
				}
				if (n > 0) ensureWorker();
				ctx.ui.notify(n ? `Requeued ${n} failed write(s).` : "No failed writes to retry.", "info");
				return;
			}

			if (sub === "drop") {
				for (const name of failed) {
					try {
						fs.unlinkSync(path.join(FAILED_DIR, name));
					} catch { /* already gone */ }
				}
				ctx.ui.notify("Discarded failed writes.", "info");
				return;
			}

			const lines = [
				`Queued: ${queued.length}${queued.length ? ` (${queued.slice(-3).join(", ")})` : ""}`,
				`Worker: ${workerIsAlive() ? "running" : "idle"}`,
				`Applied: ${done.length} (last 3 days)`,
				`Failed: ${failed.length}${failed.length ? " — run /memory-queue retry" : ""}`,
				"Recent:",
				...tailLog(6).map((l) => `  ${l}`),
			];
			ctx.ui.notify(lines.join("\n"), failed.length ? "warning" : "info");
		},
	});
}
