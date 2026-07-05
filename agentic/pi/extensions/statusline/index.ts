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
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import {
	bucketRemainingPercent,
	readCodexQuotaFromDirectory,
	type CodexQuota,
	type QuotaBucket,
} from "./codexQuota.ts";

const BAR_WIDTH = 10;
const CODEX_SESSIONS_DIR = `${process.env.HOME}/.codex/sessions`;
const CACHE_FILE = `${process.env.HOME}/.pi/agent/state/statusline/codex-quota-cache.json`;

let codexQuota: CodexQuota = {};
let requestRender: (() => void) | undefined;
let pollTimer: NodeJS.Timeout | undefined;
let installed = false;

// Debounce timeout for reading rollout files (ms)
const ROLLOUT_READ_DELAY_MS = 500;
let rolloutReadPending = false;

/**
 * Load cached quota data from previous sessions.
 * Used to show quota bars immediately (before Codex writes new rollout file).
 */
function loadCachedQuota(): CodexQuota | undefined {
	try {
		const data = readFileSync(CACHE_FILE, "utf-8");
		return JSON.parse(data) as CodexQuota;
	} catch {
		return undefined;
	}
}

/**
 * Cache quota data for next session (before rollout file is written).
 */
function saveCachedQuota(quota: CodexQuota): void {
	try {
		mkdirSync(dirname(CACHE_FILE), { recursive: true });
		writeFileSync(CACHE_FILE, JSON.stringify(quota), "utf-8");
	} catch {
		// Silently ignore (cache is non-essential)
	}
}

function hasQuotaData(quota: CodexQuota): boolean {
	return Boolean(quota.session || quota.weekly || quota.credits);
}

function loadCachedQuotaIntoMemory(): void {
	const cached = loadCachedQuota();
	if (!cached || !hasQuotaData(cached)) return;

	// Let fresh in-memory data win, while using the cache to fill first-render gaps.
	codexQuota = { ...cached, ...codexQuota };
}

let maybeRender: (() => void) | undefined;
let footerInstallId = 0;

type SetupFooterOptions = {
	force?: boolean;
	allowWithoutMessages?: boolean;
};

export default function (pi: ExtensionAPI) {
	maybeRender = () => {
		if (installed && requestRender) {
			requestRender();
		}
	};

	const setupFooter = (ctx: ExtensionContext, options: SetupFooterOptions = {}) => {
		if (!ctx.hasUI) return false;
		if (installed && !options.force) return false;

		// Only install once there's at least one message in history, except on
		// generation events where the user has just submitted but the session
		// entry may not be visible yet. This keeps the splash visible until submit.
		if (!options.allowWithoutMessages) {
			const entries = ctx.sessionManager.getEntries();
			const hasMessages = entries.some((e) => e.type === "message");
			if (!hasMessages) return false;
		}

		loadCachedQuotaIntoMemory();

		const installId = footerInstallId + 1;
		footerInstallId = installId;
		installed = true;

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();

			// Also try to read fresh data from latest rollout file.
			if (shouldPollQuota(ctx)) readCodexQuotaDebounced();

			// Poll quota periodically (every 30s)
			if (!pollTimer) {
				pollTimer = setInterval(() => {
					if (shouldPollQuota(ctx)) readCodexQuotaDebounced();
				}, 30000);
			}

			return {
				dispose() {
					if (installId !== footerInstallId) return;
					installed = false;
					requestRender = undefined;
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
		maybeRender?.();

		return true;
	};

	// Setup footer and load quota on various events
	pi.on("agent_start", (_event, ctx) => {
		setupFooter(ctx, { force: true, allowWithoutMessages: true });
		maybeRender?.();
	});
	pi.on("model_select", (_event, ctx) => {
		if (setupFooter(ctx)) return;
		maybeRender?.();
	});
	pi.on("turn_end", (_event, ctx) => {
		if (setupFooter(ctx)) return;
		readCodexQuotaDebounced();
		maybeRender?.();
	});
	pi.on("message_end", (event, ctx) => {
		// Setup/quota-load on user message end (not assistant)
		if (event.message?.role !== "user") return;

		setupFooter(ctx, { force: true, allowWithoutMessages: true });
		maybeRender?.();
		readCodexQuotaDebounced();
	});

	// Also try to read quota after provider response
	pi.on("after_provider_response", (_event, ctx) => {
		if (!shouldPollQuota(ctx)) return;
		readCodexQuotaDebounced();
		maybeRender?.();
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
		if (hasQuotaData(quota)) {
			codexQuota = quota;
			saveCachedQuota(codexQuota);
		}
		rolloutReadPending = false;
		maybeRender?.();
	}, ROLLOUT_READ_DELAY_MS);
}

/**
 * Read Codex quota from the most recent rollout JSONL data.
 */
function readCodexQuotaFromFile(): CodexQuota {
	return readCodexQuotaFromDirectory(CODEX_SESSIONS_DIR);
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
		`${theme.fg("muted", "context")} ${progressBar(contextPercent, theme)} ${theme.fg("dim", contextText)}${contextPercentText}`,
	];

	// Show cached quota immediately for Codex/subscription providers, but never
	// for explicit non-subscription inference models.
	if (shouldShowQuota(ctx, codexQuota)) {
		parts.push(...formatCodexQuota(theme, codexQuota));
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
		parts.push(`${theme.fg("muted", "credits")} ${theme.fg("accent", creditText)}`);
	}

	// Show session limit
	if (quota.session) {
		const session = formatQuotaBucket(theme, "session", quota.session);
		if (session) parts.push(session);
	}

	// Show weekly limit
	if (quota.weekly) {
		const weekly = formatQuotaBucket(theme, "weekly", quota.weekly);
		if (weekly) parts.push(weekly);
	}

	return parts;
}

function formatQuotaBucket(
	theme: ExtensionContext["ui"]["theme"],
	label: string,
	bucket: QuotaBucket,
): string | undefined {
	// Use "remaining" percent for the bar (100% = full, 0% = empty)
	const remainingPercent = bucketRemainingPercent(bucket);
	if (remainingPercent === undefined && bucket.resetAt === undefined) return undefined;

	// Build the bar showing REMAINING quota (not used)
	let text = `${theme.fg("muted", label)} ${quotaBar(remainingPercent, theme)}`;
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
				text += ` ${theme.fg("dim", `(↻ ${minsUntilReset}m)`)}`;
				return text;
			}
			format = isToday ? { hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" };
		}
		text += ` ${theme.fg("dim", `(↻ ${resetDate.toLocaleString(undefined, format)})`)}`;
	}

	return text;
}

function joinWithSeparator(theme: ExtensionContext["ui"]["theme"], parts: string[]): string {
	return parts.filter(Boolean).join(theme.fg("dim", "  │  "));
}

// ANSI color codes
const COLOR_GREEN = "\x1b[38;5;71m"; // 256-color green
const COLOR_YELLOW = "\x1b[33m"; // ANSI yellow
const COLOR_RED = "\x1b[31m"; // ANSI red
const COLOR_RESET = "\x1b[0m";

/**
 * Progress bar for context usage (goes UP as you use more).
 * Colors: green <50%, yellow 50-80%, red >80% used.
 */
function progressBar(
	percent: number | undefined,
	theme: ExtensionContext["ui"]["theme"],
): string {
	if (percent === undefined || !Number.isFinite(percent)) {
		return `[${"·".repeat(BAR_WIDTH)}]`;
	}
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * BAR_WIDTH);

	// Color based on USAGE percentage:
	// Green <50%, yellow 50-80%, red >80%
	let colorCode: string;
	if (clamped > 80) {
		colorCode = COLOR_RED;
	} else if (clamped >= 50) {
		colorCode = COLOR_YELLOW;
	} else {
		colorCode = COLOR_GREEN;
	}

	const barChar = `${colorCode}█${COLOR_RESET}`;
	const emptyChar = theme.fg("dim", "░");
	return `[${barChar.repeat(filled)}${emptyChar.repeat(BAR_WIDTH - filled)}]`;
}

/**
 * Progress bar for quota remaining (goes DOWN as you use more).
 * Colors: green >50% remaining, yellow 20-50%, red <20%.
 */
function quotaBar(
	percent: number | undefined,
	theme: ExtensionContext["ui"]["theme"],
): string {
	if (percent === undefined || !Number.isFinite(percent)) {
		return `[${"·".repeat(BAR_WIDTH)}]`;
	}
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * BAR_WIDTH);

	// Color based on REMAINING percentage:
	// Green >50%, yellow 20-50%, red <20%
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

function isInferenceProvider(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "inference";
}

function isSubscription(ctx: ExtensionContext): boolean {
	if (!ctx.model) return false;
	return ctx.modelRegistry.isUsingOAuth(ctx.model);
}

function shouldShowQuota(ctx: ExtensionContext, quota: CodexQuota): boolean {
	if (isInferenceProvider(ctx)) return false;
	if (isCodex(ctx) || isSubscription(ctx)) return true;
	return !ctx.model && hasQuotaData(quota);
}

function shouldPollQuota(ctx: ExtensionContext): boolean {
	if (isInferenceProvider(ctx)) return false;
	if (isCodex(ctx) || isSubscription(ctx)) return true;
	return !ctx.model && hasQuotaData(codexQuota);
}
