/** `/loop [duration] [--max-runs N] <prompt> [--until <condition>]`. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkCondition, type Verdict } from "./checker.ts";
import { setLoopActive } from "../_loop_state/state.ts";
import { NON_INTERACTIVE_BANNER } from "../non-interactive/prompt.ts";

const STATUS_KEY = "loop";
const MAX_DURATION_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_UNTIL_CAP = 20;
const COMPACTION_INSTRUCTIONS =
	"Summarize this loop's goal, constraints, work completed, failed attempts, current file state, " +
	"and the next concrete step. Keep the summary brief but retain information needed by the next iteration.";
const USAGE = "Usage: /loop [1h2m3s] [--max-runs N] <prompt> [--until <condition>] | /loop status | /loop stop";

export interface LoopOptions {
	intervalMs: number;
	prompt: string;
	condition?: string;
	maxRuns?: number;
}

export function parseDuration(value: string): number | undefined {
	const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
	if (!match || !match.slice(1).some((part) => part !== undefined)) return undefined;
	const total = Number(match[1] ?? 0) * 3_600_000 + Number(match[2] ?? 0) * 60_000 + Number(match[3] ?? 0) * 1_000;
	return Number.isSafeInteger(total) && total > 0 && total <= MAX_DURATION_MS ? total : undefined;
}

export function parseLoopArgs(args: string): LoopOptions {
	let rest = args.trim();
	if (!rest) throw new Error(USAGE);
	let condition: string | undefined;
	const delimiter = /\s+--until(?:\s+|$)/g;
	const boundaries = [...rest.matchAll(delimiter)];
	if (boundaries.length > 1) throw new Error(USAGE);
	if (boundaries.length === 1) {
		const boundary = boundaries[0];
		condition = rest.slice(boundary.index! + boundary[0].length).trim();
		rest = rest.slice(0, boundary.index).trim();
		if (!condition) throw new Error(USAGE);
	}
	let intervalMs = 0;
	const first = /^(\S+)(?:\s+|$)/.exec(rest);
	if (first) {
		const duration = parseDuration(first[1]);
		if (duration !== undefined) {
			intervalMs = duration;
			rest = rest.slice(first[0].length).trim();
		} else if (/^\d+$|^\d+(?:\.\d+)?[hms]/.test(first[1])) {
			throw new Error(`Invalid duration: ${first[1]}. Use s, m, h, or combinations such as 1m30s.`);
		}
	}
	let maxRuns: number | undefined;
	const cap = /^--max-runs(?:\s+(\S+))?(?:\s+|$)/.exec(rest);
	if (cap) {
		maxRuns = Number(cap[1]);
		if (!cap[1] || !/^\d+$/.test(cap[1]) || !Number.isSafeInteger(maxRuns) || maxRuns < 1) {
			throw new Error("--max-runs requires a positive integer.");
		}
		rest = rest.slice(cap[0].length).trim();
	}
	if (!rest || rest.startsWith("--until") || rest.startsWith("--max-runs")) throw new Error(USAGE);
	return { intervalMs, prompt: rest, condition, maxRuns: maxRuns ?? (condition ? DEFAULT_UNTIL_CAP : undefined) };
}

type Checker = (condition: string, output: string, ctx: ExtensionContext, signal: AbortSignal) => Promise<Verdict>;
interface Dependencies {
	check?: Checker;
	setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}
interface ActiveLoop extends LoopOptions {
	runs: number;
	phase: "running" | "checking" | "waiting" | "compacting";
	compacted: boolean;
	lastOutput?: string;
	failed?: boolean;
	generation: number;
	ctx: ExtensionContext;
}

export default function (pi: ExtensionAPI, deps: Dependencies = {}) {
	const check = deps.check ?? checkCondition;
	const setTimer = deps.setTimer ?? setTimeout;
	const clearTimer = deps.clearTimer ?? clearTimeout;
	let active: ActiveLoop | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let startWatchdog: ReturnType<typeof setTimeout> | undefined;
	let checker: AbortController | undefined;
	let generation = 0;

	function say(message: string) {
		pi.sendMessage({ customType: "loop:status", content: message, display: true });
	}
	function updateStatus(ctx: ExtensionContext) {
		ctx.ui.setStatus(STATUS_KEY, active ? `↻ ${active.runs}${active.maxRuns ? `/${active.maxRuns}` : ""} ${active.phase}` : undefined);
	}
	function stop(reason?: string) {
		generation++;
		if (timer !== undefined) clearTimer(timer);
		timer = undefined;
		if (startWatchdog !== undefined) clearTimer(startWatchdog);
		startWatchdog = undefined;
		checker?.abort();
		checker = undefined;
		const old = active;
		active = undefined;
		if (old) {
			setLoopActive(false, old.ctx);
			updateStatus(old.ctx);
		}
		if (reason && old) say(reason);
	}
	function hasEnoughContextToCompact(loop: ActiveLoop): boolean {
		const tokens = loop.ctx.getContextUsage()?.tokens;
		if (tokens === null || tokens === undefined) return true;
		const settings = pi.getSettings().compaction;
		const modelKey = loop.ctx.model ? `${loop.ctx.model.provider}/${loop.ctx.model.id}` : undefined;
		const keepRecent = (modelKey ? settings?.modelOverrides?.[modelKey]?.keepRecentTokens : undefined)
			?? settings?.keepRecentTokens ?? 20_000;
		return tokens > keepRecent;
	}
	function schedule(loop: ActiveLoop) {
		if (active !== loop) return;
		loop.phase = "waiting";
		loop.compacted = false;
		updateStatus(loop.ctx);
		const token = loop.generation;
		const tick = () => {
			timer = undefined;
			if (active !== loop || generation !== token) return;
			if (!loop.ctx.isIdle() || loop.ctx.hasPendingMessages()) {
				timer = setTimer(tick, 1_000);
				return;
			}
			if (!loop.compacted) {
				// Pi cannot summarize entries wholly within its keep-recent window.
				// Avoid a noisy "session too small" error on every short iteration.
				if (!hasEnoughContextToCompact(loop)) {
					loop.compacted = true;
					timer = setTimer(tick, 0);
					return;
				}
				loop.phase = "compacting";
				updateStatus(loop.ctx);
				const resume = () => {
					if (active !== loop || generation !== token) return;
					loop.compacted = true;
					loop.phase = "waiting";
					updateStatus(loop.ctx);
					// Run on a later tick: the compaction callback can fire while Pi
					// is still completing its own cleanup and idle transition.
					timer = setTimer(tick, 0);
				};
				try {
					loop.ctx.compact({
						customInstructions: COMPACTION_INSTRUCTIONS,
						onComplete: resume,
						onError: (error) => {
							if (active !== loop || generation !== token) return;
							if (/^(Nothing to compact \(session too small\)|Already compacted)$/.test(error.message)) resume();
							else stop(`Loop stopped: compaction failed (${error.message}).`);
						},
					});
				} catch (error) {
					stop(`Loop stopped: compaction failed (${String(error)}).`);
				}
				return;
			}
			run(loop);
		};
		timer = setTimer(tick, loop.intervalMs);
	}
	function run(loop: ActiveLoop) {
		if (active !== loop) return;
		loop.runs++;
		loop.phase = "running";
		loop.lastOutput = undefined;
		loop.failed = false;
		updateStatus(loop.ctx);
		// sendUserMessage is void: Pi reports asynchronous submission errors via
		// its error channel rather than throwing. Fail closed if no turn starts.
		startWatchdog = setTimer(() => {
			startWatchdog = undefined;
			if (active === loop && loop.phase === "running") stop("Loop stopped: the next turn did not start (check Pi errors/authentication).");
		}, 60_000);
		try {
			pi.sendUserMessage(`${NON_INTERACTIVE_BANNER}\n\n${loop.prompt}`);
		} catch (error) {
			stop(`Loop stopped: unable to send prompt (${String(error)}).`);
		}
	}

	pi.registerCommand("loop", {
		description: "Repeat a prompt, optionally checking an --until condition after every run",
		async handler(args, ctx) {
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
				console.error("/loop requires an interactive Pi (TUI or RPC) session; print/JSON mode exits before scheduled turns.");
				return;
			}
			const command = args.trim();
			if (command === "stop") {
				if (active) stop("Loop stopped; any running iteration may finish.");
				else say("No loop is active.");
				return;
			}
			if (command === "status") {
				say(active
					? `Loop: ${active.phase}, run ${active.runs}${active.maxRuns ? `/${active.maxRuns}` : ""}, ${active.intervalMs ? `${active.intervalMs / 1_000}s delay` : "no delay"}${active.condition ? ", checking --until" : ""}.`
					: "No loop is active.");
				return;
			}
			if (active) {
				say("A loop is already active. Use /loop stop before starting another.");
				return;
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				say("Wait until Pi is idle before starting a loop.");
				return;
			}
			let options: LoopOptions;
			try { options = parseLoopArgs(args); } catch (error) {
				say(String(error instanceof Error ? error.message : error));
				return;
			}
			active = { ...options, runs: 0, phase: "running", compacted: false, generation: ++generation, ctx };
			setLoopActive(true, ctx);
			run(active);
		},
	});

	pi.on("input", (event) => {
		if (active && event.source !== "extension") stop("Loop stopped: new user input.");
	});
	pi.on("agent_start", () => {
		if (startWatchdog !== undefined) clearTimer(startWatchdog);
		startWatchdog = undefined;
	});
	pi.on("agent_end", (event) => {
		if (!active || active.phase !== "running") return;
		const final = [...event.messages].reverse().find((message) => message.role === "assistant");
		if (!final || final.role !== "assistant" || final.stopReason !== "stop") {
			active.failed = true;
			return;
		}
		active.lastOutput = final.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
	});
	function nextOrStop(loop: ActiveLoop) {
		if (active !== loop) return;
		if (loop.maxRuns && loop.runs >= loop.maxRuns) {
			stop(`Loop stopped: maximum of ${loop.maxRuns} runs reached without completion.`);
			return;
		}
		schedule(loop);
	}
	async function evaluate(loop: ActiveLoop, ctx: ExtensionContext, controller: AbortController) {
		let verdict: Verdict;
		try {
			verdict = await check(loop.condition!, loop.lastOutput!, ctx, controller.signal);
		} catch (error) {
			if (active === loop) stop(`Loop stopped: completion check failed (${String(error)}).`);
			return;
		} finally {
			if (checker === controller) checker = undefined;
		}
		if (active !== loop || controller.signal.aborted) return;
		if (verdict.done) {
			stop(`Loop complete after ${loop.runs} run(s): ${verdict.evidence}`);
			return;
		}
		nextOrStop(loop);
	}
	pi.on("agent_settled", (_event, ctx) => {
		const loop = active;
		if (!loop || loop.phase !== "running") return;
		if (loop.failed || loop.lastOutput === undefined) {
			stop("Loop stopped: iteration failed or was interrupted.");
			return;
		}
		if (loop.condition) {
			loop.phase = "checking";
			updateStatus(ctx);
			const controller = new AbortController();
			checker = controller;
			// Do not await here: Pi defers user input, even /loop stop, while
			// agent_settled handlers are pending.
			void evaluate(loop, ctx, controller);
			return;
		}
		nextOrStop(loop);
	});
	function reset(ctx: ExtensionContext) {
		stop();
		// A reload may recreate this extension while the process-wide signal
		// still belongs to the old instance, which no longer has an active loop.
		setLoopActive(false, ctx);
	}
	pi.on("session_shutdown", (_event, ctx) => reset(ctx));
	pi.on("session_start", (_event, ctx) => reset(ctx));
	pi.on("session_tree", (_event, ctx) => reset(ctx));
}
