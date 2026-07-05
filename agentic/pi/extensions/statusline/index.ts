/**
 * Compact statusline footer.
 *
 * Replaces Pi's built-in interactive footer with a single statusline containing
 * the active model, context window, and context usage. For OAuth subscription models
 * (e.g., OpenAI Codex, Anthropic Claude Pro), renders quota bars by reading from
 * Codex session rollout files (~/.codex/sessions/rollout-*.jsonl).
 *
 * Quota bars show "remaining" (not used): 100% when full, counting down.
 * Colors: green > 50%, yellow 20-50%, red < 20%.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { spawnSync } from "child_process";

type QuotaBucket = {
	used?: number;
	limit?: number;
	remaining?: number;
	percent?: number;
	resetAt?: number;
	window?: "5min" | "5h" | "12h" | "24h" | "7d" | "30d";
};

type CodexQuota = {
	session?: QuotaBucket;
	weekly?: QuotaBucket;
	credits?: {
		balance: number;
		unlimited: boolean;
	};
};

const BAR_WIDTH = 10;

let codexQuota: CodexQuota = {};
let requestRender: (() => void) | undefined;
let pollTimer: NodeJS.Timeout | undefined;
let installed = false;

// Debounce timeout for reading rollout files (ms)
const ROLLOUT_READ_DELAY_MS = 500;
let rolloutReadPending = false;

export default function (pi: ExtensionAPI) {
	const install = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || installed) return;

		// Only install once there's at least one message in history.
		// This ensures splash screen stays visible until user submits first message.
		const entries = ctx.sessionManager.getEntries();
		const hasMessages = entries.some((e) => e.type === "message");
		if (!hasMessages) return;

		installed = true;

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();

			// Read Codex quota periodically (every 30s) and on install
			if (!pollTimer) {
				readCodexQuotaDebounced();
				pollTimer = setInterval(() => readCodexQuotaDebounced(), 30000);
			}

			return {
				dispose() {
					if (requestRender) requestRender = undefined;
					if (pollTimer) {
						clearInterval(pollTimer);
						pollTimer = undefined;
					}
				},
				invalidate() {},
				render(width: number): string[] {
					const line = buildStatusline(ctx, theme, footerData);
					return [' ' + truncateToWidth(line, width - 1), ''];
				},
			};
		});
	};

	// Install on agent_start (processing user message), model_select, and turn_end.
	// Install on message_end (when user message is stored) to show footer immediately.
	// NOT on session_start - splash screen also sets footer there and
	// should remain visible until user submits first message.
	pi.on("agent_start", (_event, ctx) => install(ctx));
	pi.on("model_select", (_event, ctx) => install(ctx));
	pi.on("turn_end", (_event, ctx) => {
		install(ctx);
		requestRender?.();
		readCodexQuotaDebounced();
	});
	pi.on("message_end", (event, ctx) => {
		// Only install when user message ends (not assistant messages)
		if (event.message?.role !== "user") return;
		install(ctx);
		requestRender?.();
		readCodexQuotaDebounced();
	});

	// Also try to read quota after provider response
	pi.on("after_provider_response", (event, ctx) => {
		if (!isCodex(ctx) && !isSubscription(ctx)) return;
		readCodexQuotaDebounced();
	});
}

/**
 * Debounced Codex quota read - avoids file thrashing during active streaming.
 */
function readCodexQuotaDebounced() {
	if (rolloutReadPending) return;
	rolloutReadPending = true;

	// Small delay so we read after Codex has written the rollout file
	setTimeout(() => {
		const quota = readCodexQuotaFromFile();
		if (quota.session || quota.weekly || quota.credits) {
			codexQuota = { ...codexQuota, ...quota };
		}
		rolloutReadPending = false;
		requestRender?.();
	}, ROLLOUT_READ_DELAY_MS);
}

/**
 * Read Codex quota from the most recent rollout file.
 * Uses `find` and `jq` to parse the rate_limits event.
 */
function readCodexQuotaFromFile(): CodexQuota {
	try {
		// Find the most recent rollout file with rate_limits data
		const findCmd = `find ~/.codex/sessions -name 'rollout-*.jsonl' -type f -exec sh -c 'grep -q "rate_limits" "$1" && echo "$1"' _ {} \\; 2>/dev/null | sort -r | head -1`;
		
		const findResult = spawnSync("bash", ["-c", findCmd], {
			encoding: "utf-8",
			timeout: 2000,
		});

		const latestFile = findResult.stdout.trim();
		if (!latestFile) return {};

		// Extract the last rate_limits event using jq
		const jqCmd = `grep "rate_limits" "${latestFile}" | tail -1 | jq -c '.payload.rate_limits'`;
		const jqResult = spawnSync("bash", ["-c", jqCmd], {
			encoding: "utf-8",
			timeout: 2000,
		});

		if (!jqResult.stdout.trim()) return {};

		const rateLimits = JSON.parse(jqResult.stdout.trim());
		return parseCodexRateLimits(rateLimits);
	} catch {
		// Silently ignore errors (no Codex data, jq not available, etc.)
		return {};
	}
}

/**
 * Parse raw rate_limits JSON into our CodexQuota structure.
 */
function parseCodexRateLimits(raw: Record<string, unknown>): CodexQuota {
	const result: CodexQuota = {};

	// Credits-based quota (when rate limited)
	if (raw.credits) {
		result.credits = {
			balance: parseFloat(raw.credits.balance) || 0,
			unlimited: raw.credits.unlimited || false,
		};
	}

	// Window-based limits (session + weekly)
	if (raw.primary) {
		result.session = {
			used: raw.primary.used_percent,
			remaining: 100 - (raw.primary.used_percent || 0),
			percent: raw.primary.used_percent,
			resetAt: raw.primary.resets_at ? Math.floor(raw.primary.resets_at * 1000) : undefined,
			window: classifyWindow(raw.primary.window_minutes),
		};
	}

	if (raw.secondary) {
		result.weekly = {
			used: raw.secondary.used_percent,
			remaining: 100 - (raw.secondary.used_percent || 0),
			percent: raw.secondary.used_percent,
			resetAt: raw.secondary.resets_at ? Math.floor(raw.secondary.resets_at * 1000) : undefined,
			window: classifyWindow(raw.secondary.window_minutes),
		};
	}

	return result;
}

/**
 * Classify window_minutes into human-readable label.
 */
function classifyWindow(minutes: number | undefined): QuotaBucket["window"] {
	if (minutes === undefined) return undefined;
	if (minutes <= 5) return "5min";
	if (minutes <= 300) return "5h";
	if (minutes <= 720) return "12h";
	if (minutes <= 1440) return "24h";
	if (minutes <= 10080) return "7d";
	return "30d";
}

function buildStatusline(
	ctx: ExtensionContext,
	theme: ExtensionContext["ui"]["theme"],
	footerData: ReadonlyFooterDataProvider,
): string {
	const model = ctx.model;
	const modelName = model?.name || model?.id || "no model";
	const contextWindow = model?.contextWindow ?? ctx.getContextUsage()?.contextWindow;
	const context = ctx.getContextUsage();
	const contextPercent = context?.percent ?? undefined;
	const contextText = `${formatTokens(context?.tokens)} / ${formatTokens(contextWindow)}`;
	const contextPercentText = contextPercent !== undefined ? ` ${theme.fg("dim", `(${Math.round(contextPercent)}%)`)}` : "";
	const parts = [
		theme.fg("accent", modelName),
		`${theme.fg("muted", "ctx")} ${progressBar(contextPercent, theme)} ${theme.fg("dim", contextText)}${contextPercentText}`,
	];

	// Show quota bars for subscription models (OAuth) or Codex
	if (isSubscription(ctx) || isCodex(ctx)) {
		const codexParts = formatCodexQuota(theme, codexQuota);
		parts.push(...codexParts);
	}

	parts.push(...formatExtensionStatuses(footerData));

	return joinWithSeparator(theme, parts);
}

function formatExtensionStatuses(footerData: ReadonlyFooterDataProvider): string[] {
	return Array.from(footerData.getExtensionStatuses().entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([ext, text]) => {
			const sanitized = sanitizeStatusText(text);
			// Hide MCP status when no servers are active (e.g. "MCP: 0/1 servers")
			if (ext === "mcp" && sanitized.includes("0/")) return "";
			return sanitized;
		})
		.filter((text) => text.length > 0);
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatCodexQuota(theme: ExtensionContext["ui"]["theme"], quota: CodexQuota): string[] {
	const parts: string[] = [];

	// Show credits if we're on credits system (rate limited or credit-based plan)
	if (quota.credits) {
		const creditText = quota.credits.unlimited
			? "∞"
			: quota.credits.balance.toString();
		parts.push(`${theme.fg("muted", "cr")} ${theme.fg("accent", creditText)}`);
	}

	// Show session limit
	if (quota.session) {
		const session = formatQuotaBucket(theme, "ses", quota.session);
		if (session) parts.push(session);
	}

	// Show weekly limit
	if (quota.weekly) {
		const weekly = formatQuotaBucket(theme, "wk", quota.weekly);
		if (weekly) parts.push(weekly);
	}

	return parts;
}

function formatQuotaBucket(
	theme: ExtensionContext["ui"]["theme"],
	label: string,
	bucket: QuotaBucket,
): string {
	// Use "remaining" percent for the bar (100% = full, 0% = empty)
	const remainingPercent = bucket.remaining ?? bucketPercent(bucket);
	if (remainingPercent === undefined && bucket.resetAt === undefined) return undefined;

	// Build the bar showing REMAINING quota (not used)
	let text = `${theme.fg("muted", label)} ${progressBar(remainingPercent, theme)}`;
	if (remainingPercent !== undefined) {
		text += ` ${theme.fg("dim", `${Math.round(remainingPercent)}%`)}`;
	}

	// Add reset time
	if (bucket.resetAt !== undefined) {
		const resetDate = new Date(bucket.resetAt);
		const now = new Date();
		const isToday = resetDate.toDateString() === now.toDateString();

		let format: Intl.DateTimeFormatOptions;
		if (bucket.window === "7d" || bucket.window === "30d") {
			// Weekly/monthly: show day + time
			format = { weekday: "short", hour: "2-digit", minute: "2-digit" };
		} else {
			// Session: show time only (or "soon" if within 1 hour)
			const minsUntilReset = Math.floor((bucket.resetAt - now.getTime()) / 60000);
			if (minsUntilReset <= 60) {
				text += ` ${theme.fg("dim", `↻ ${minsUntilReset}m`)}`;
				return text;
			}
			format = isToday ? { hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" };
		}
		text += ` ${theme.fg("dim", `↻ ${resetDate.toLocaleString(undefined, format)}`)}`;
	}

	return text;
}

function joinWithSeparator(theme: ExtensionContext["ui"]["theme"], parts: string[]): string {
	return parts.filter(Boolean).join(theme.fg("dim", "  │  "));
}

// ANSI color codes for quota remaining bars
// Green when >50% remaining, yellow 20-50%, red <20%
const COLOR_GREEN = "\x1b[38;5;71m"; // 256-color green
const COLOR_YELLOW = "\x1b[33m"; // ANSI yellow
const COLOR_RED = "\x1b[31m"; // ANSI red
const COLOR_RESET = "\x1b[0m";

function progressBar(
	percent: number | undefined,
	theme: ExtensionContext["ui"]["theme"],
): string {
	if (percent === undefined || !Number.isFinite(percent)) {
		return `[${"·".repeat(BAR_WIDTH)}]`;
	}
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * BAR_WIDTH);

	// Color based on REMAINING percentage:
	// Green when >50% remaining, yellow 20-50%, red <20%
	let colorCode: string;
	if (clamped >= 50) {
		colorCode = COLOR_GREEN;
	} else if (clamped >= 20) {
		colorCode = COLOR_YELLOW;
	} else {
		colorCode = COLOR_RED;
	}

	const barChar = `${colorCode}█${COLOR_RESET}`;
	const emptyChar = theme.fg("dim", "░");
	return `[${barChar.repeat(filled)}${emptyChar.repeat(BAR_WIDTH - filled)}]`;
}

function formatTokens(value: number | null | undefined): string {
	if (value === undefined || value === null || !Number.isFinite(value)) return "?";
	if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return String(Math.round(value));
}

function isCodex(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "openai-codex" || ctx.model?.api === "openai-codex-responses";
}

function isSubscription(ctx: ExtensionContext): boolean {
	if (!ctx.model) return false;
	return ctx.modelRegistry.isUsingOAuth(ctx.model);
}

function bucketPercent(bucket: QuotaBucket): number | undefined {
	if (bucket.percent !== undefined) return bucket.percent > 1 ? bucket.percent : bucket.percent * 100;
	if (bucket.used !== undefined && bucket.limit !== undefined && bucket.limit > 0) return (bucket.used / bucket.limit) * 100;
	if (bucket.remaining !== undefined && bucket.limit !== undefined && bucket.limit > 0) {
		return ((bucket.limit - bucket.remaining) / bucket.limit) * 100;
	}
	return undefined;
}
