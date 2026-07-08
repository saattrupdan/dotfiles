/**
 * Compact statusline footer.
 *
 * Replaces Pi's built-in interactive footer with a single statusline containing
 * the active model, context window, and context usage. For subscription-backed
 * providers, renders quota bars by fetching live quota from the provider's own
 * local/account source: Codex response headers for OpenAI Codex, and Claude Code's
 * local `/usage` command for Claude Code.
 *
 * Pi issues its own codex requests over WebSocket and never writes ~/.codex
 * rollout files, so Codex bars are refreshed by making a minimal request of our
 * own. Claude Code exposes the same subscription percentages through `/usage`.
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
	fetchClaudeQuotaFromCli,
	fetchCodexQuotaFromApi,
	type CodexQuota,
	type QuotaBucket,
} from "./codexQuota.ts";

const BAR_WIDTH = 10;
const CODEX_CACHE_FILE = `${process.env.HOME}/.pi/agent/state/statusline/codex-quota-cache.json`;
const CLAUDE_CACHE_FILE = `${process.env.HOME}/.pi/agent/state/statusline/claude-quota-cache.json`;

type QuotaSource = "codex" | "claude";

let codexQuota: CodexQuota = {};
let claudeQuota: CodexQuota = {};
let requestRender: (() => void) | undefined;
let pollTimer: NodeJS.Timeout | undefined;
let installed = false;

// Re-render cadence (keeps reset countdowns fresh).
const RENDER_TICK_MS = 60_000;
// Minimum spacing between non-forced (background) quota probes.
const BACKGROUND_FETCH_INTERVAL_MS = 5 * 60_000;
let quotaFetchInFlight = false;
let lastQuotaFetchMs = 0;

/**
 * Load cached quota data from previous sessions.
 * Used to show quota bars immediately (before Codex writes new rollout file).
 */
function loadCachedQuota(source: QuotaSource): CodexQuota | undefined {
	try {
		const data = readFileSync(cacheFileForSource(source), "utf-8");
		const parsed = JSON.parse(data) as CodexQuota;
		return hasQuotaData(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Cache quota data for next session (before rollout file is written).
 */
function saveCachedQuota(source: QuotaSource, quota: CodexQuota): void {
	const cacheFile = cacheFileForSource(source);
	try {
		mkdirSync(dirname(cacheFile), { recursive: true });
		writeFileSync(cacheFile, JSON.stringify(quota), "utf-8");
	} catch {
		// Silently ignore (cache is non-essential)
	}
}

function cacheFileForSource(source: QuotaSource): string {
	return source === "claude" ? CLAUDE_CACHE_FILE : CODEX_CACHE_FILE;
}

function hasQuotaData(quota: CodexQuota): boolean {
	return Boolean(quota.session || quota.weekly || quota.credits);
}

function loadCachedQuotaIntoMemory(): void {
	const cachedCodex = loadCachedQuota("codex");
	if (cachedCodex) {
		// Let fresh in-memory data win, while using the cache to fill first-render gaps.
		codexQuota = { ...cachedCodex, ...codexQuota };
	}

	const cachedClaude = loadCachedQuota("claude");
	if (cachedClaude) {
		claudeQuota = { ...cachedClaude, ...claudeQuota };
	}
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

			// Populate live quota as soon as the footer installs.
			refreshQuota(ctx, { force: true });

			// Keep reset countdowns fresh, and probe quota on a slow cadence.
			if (!pollTimer) {
				pollTimer = setInterval(() => {
					refreshQuota(ctx);
					maybeRender?.();
				}, RENDER_TICK_MS);
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
		// Switched model — refresh against the right account/source.
		refreshQuota(ctx, { force: true });
		maybeRender?.();
	});
	pi.on("turn_end", (_event, ctx) => {
		if (setupFooter(ctx)) return;
		// Usage just changed on the backend — refresh now.
		refreshQuota(ctx, { force: true });
		maybeRender?.();
	});
	pi.on("message_end", (event, ctx) => {
		// Setup/quota-load on user message end (not assistant)
		if (event.message?.role !== "user") return;

		setupFooter(ctx, { force: true, allowWithoutMessages: true });
		maybeRender?.();
		refreshQuota(ctx, { force: true });
	});
}

/**
 * Fetch live Codex quota from the responses API and update the bars.
 *
 * Non-forced calls are throttled to BACKGROUND_FETCH_INTERVAL_MS so idle polling
 * stays cheap; forced calls (after a turn / on install) always run.
 */
function refreshQuota(ctx: ExtensionContext, options: { force?: boolean } = {}): void {
	const source = quotaSourceForContext(ctx);
	if (!source) return;
	if (quotaFetchInFlight) return;

	const now = Date.now();
	if (!options.force && now - lastQuotaFetchMs < BACKGROUND_FETCH_INTERVAL_MS) return;

	quotaFetchInFlight = true;
	lastQuotaFetchMs = now;
	const model = ctx.model?.id;
	const fetchQuota = source === "claude"
		? fetchClaudeQuotaFromCli()
		: fetchCodexQuotaFromApi(model);

	void fetchQuota
		.then((quota) => {
			if (quota && hasQuotaData(quota)) {
				setQuotaForSource(source, quota);
				saveCachedQuota(source, quota);
				maybeRender?.();
			}
		})
		.finally(() => {
			quotaFetchInFlight = false;
		});
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

	// Show cached quota immediately for subscription providers, but never for
	// explicit non-subscription inference models.
	const quota = quotaForContext(ctx);
	if (shouldShowQuota(ctx, quota)) {
		parts.push(...formatCodexQuota(theme, quota));
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

function quotaSourceForContext(ctx: ExtensionContext): QuotaSource | undefined {
	if (isCodex(ctx)) return "codex";
	if (isClaudeCode(ctx)) return "claude";
	return undefined;
}

function quotaForContext(ctx: ExtensionContext): CodexQuota {
	const source = quotaSourceForContext(ctx);
	if (source === "claude") return claudeQuota;
	return codexQuota;
}

function setQuotaForSource(source: QuotaSource, quota: CodexQuota): void {
	if (source === "claude") {
		claudeQuota = quota;
		return;
	}
	codexQuota = quota;
}

function isCodex(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "openai-codex" || ctx.model?.api === "openai-codex-responses";
}

function isClaudeCode(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "claude-code" || ctx.model?.api === "claude-code-cli";
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
	if (isCodex(ctx) || isClaudeCode(ctx) || isSubscription(ctx)) return true;
	return !ctx.model && hasQuotaData(quota);
}
