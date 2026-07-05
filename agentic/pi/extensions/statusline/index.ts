/**
 * Compact statusline footer.
 *
 * Replaces Pi's built-in interactive footer with a single statusline containing
 * the active model, context window, and context usage. For OpenAI Codex models,
 * also renders quota bars when the provider exposes reset/usage headers.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

type QuotaBucket = {
	used?: number;
	limit?: number;
	remaining?: number;
	percent?: number;
	resetAt?: number;
};

type CodexQuota = {
	session?: QuotaBucket;
	weekly?: QuotaBucket;
};

const BAR_WIDTH = 10;

let codexQuota: CodexQuota = {};
let requestRender: (() => void) | undefined;

export default function (pi: ExtensionAPI) {
	const install = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();

			return {
				dispose() {
					if (requestRender) requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const line = buildStatusline(ctx, theme, footerData);
					return [truncateToWidth(line, width)];
				},
			};
		});
	};

	// Install on agent_start (processing user message) and model_select.
	// NOT on session_start - splash screen also sets footer there and
	// should remain visible until user submits first message.
	pi.on("agent_start", (_event, ctx) => install(ctx));
	pi.on("model_select", (_event, ctx) => install(ctx));
	pi.on("turn_end", (_event, _ctx) => requestRender?.());
	pi.on("message_end", (_event, _ctx) => requestRender?.());

	pi.on("after_provider_response", (event, ctx) => {
		if (!isCodex(ctx)) return;
		const next = parseCodexQuota(event.headers);
		if (next.session || next.weekly) {
			codexQuota = { ...codexQuota, ...next };
			requestRender?.();
		}
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
	const parts = [
		theme.fg("accent", modelName),
		`${theme.fg("muted", "ctx")} ${progressBar(contextPercent, theme)} ${theme.fg("dim", contextText)}`,
	];

	if (isCodex(ctx)) {
		const codexParts = formatCodexQuota(theme, codexQuota);
		parts.push(...codexParts);
	}

	parts.push(...formatExtensionStatuses(footerData));

	return joinWithSeparator(theme, parts);
}

function formatExtensionStatuses(footerData: ReadonlyFooterDataProvider): string[] {
	return Array.from(footerData.getExtensionStatuses().entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text))
		.filter((text) => text.length > 0);
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatCodexQuota(theme: ExtensionContext["ui"]["theme"], quota: CodexQuota): string[] {
	const parts: string[] = [];
	const session = formatQuotaBucket(theme, "ses", quota.session, true);
	if (session) parts.push(session);
	const weekly = formatQuotaBucket(theme, "wk", quota.weekly, false);
	if (weekly) parts.push(weekly);
	return parts;
}

function formatQuotaBucket(
	theme: ExtensionContext["ui"]["theme"],
	label: string,
	bucket: QuotaBucket | undefined,
	includeTime: boolean,
): string | undefined {
	if (!bucket) return undefined;
	const percent = bucketPercent(bucket);
	if (percent === undefined && bucket.resetAt === undefined) return undefined;

	let text = `${theme.fg("muted", label)} ${progressBar(percent, theme)}`;
	if (percent !== undefined) text += ` ${theme.fg("dim", `${Math.round(percent)}%`)}`;
	if (bucket.resetAt !== undefined) {
		const format: Intl.DateTimeFormatOptions = includeTime
			? { hour: "2-digit", minute: "2-digit" }
			: { weekday: "short", hour: "2-digit", minute: "2-digit" };
		text += ` ${theme.fg("dim", `↺ ${new Date(bucket.resetAt).toLocaleString(undefined, format)}`)}`;
	}
	return text;
}

function joinWithSeparator(theme: ExtensionContext["ui"]["theme"], parts: string[]): string {
	return parts.filter(Boolean).join(theme.fg("dim", "  │  "));
}

function progressBar(
	percent: number | undefined,
	theme: ExtensionContext["ui"]["theme"],
): string {
	if (percent === undefined || !Number.isFinite(percent)) {
		return `[${"·".repeat(BAR_WIDTH)}]`;
	}
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * BAR_WIDTH);

	// Color the bar based on usage thresholds (matching Claude Code pattern)
	let color: "success" | "warning" | "error" = "success";
	if (clamped >= 80) {
		color = "error";
	} else if (clamped >= 50) {
		color = "warning";
	}

	const barChar = theme.fg(color, "█");
	const emptyChar = theme.fg("dim", "░");
	return `[${barChar.repeat(filled)}${emptyChar.repeat(BAR_WIDTH - filled)}]`;
}

function formatTokens(value: number | null | undefined): string {
	if (value === undefined || value === null || !Number.isFinite(value)) return "?";
	if (value >= 1_000_000) return `${trimFixed(value / 1_000_000)}M`;
	if (value >= 1_000) return `${trimFixed(value / 1_000)}k`;
	return String(Math.round(value));
}

function trimFixed(value: number): string {
	return value.toFixed(1).replace(/\.0$/, "");
}

function isCodex(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "openai-codex" || ctx.model?.api === "openai-codex-responses";
}

function parseCodexQuota(headers: Record<string, string>): CodexQuota {
	const normalized = normalizeHeaders(headers);
	return {
		session: parseBucket(normalized, "session", ["session", "five-hour", "five_hour", "5h", "request"]),
		weekly: parseBucket(normalized, "weekly", ["weekly", "seven-day", "seven_day", "7d", "week"]),
	};
}

function parseBucket(headers: ReadonlyMap<string, string>, canonical: string, aliases: string[]): QuotaBucket | undefined {
	const used = getNumericHeader(headers, aliases, ["used", "usage", "consumed"]);
	const limit = getNumericHeader(headers, aliases, ["limit", "total"]);
	const remaining = getNumericHeader(headers, aliases, ["remaining", "left"]);
	const percent = getNumericHeader(headers, aliases, ["percent", "pct", "usage-percent"]);
	const resetAt = getResetHeader(headers, [canonical, ...aliases]);
	const bucket: QuotaBucket = { used, limit, remaining, percent, resetAt };

	if (used === undefined && limit === undefined && remaining === undefined && percent === undefined && resetAt === undefined) {
		return undefined;
	}
	return bucket;
}

function bucketPercent(bucket: QuotaBucket): number | undefined {
	if (bucket.percent !== undefined) return bucket.percent > 1 ? bucket.percent : bucket.percent * 100;
	if (bucket.used !== undefined && bucket.limit !== undefined && bucket.limit > 0) return (bucket.used / bucket.limit) * 100;
	if (bucket.remaining !== undefined && bucket.limit !== undefined && bucket.limit > 0) {
		return ((bucket.limit - bucket.remaining) / bucket.limit) * 100;
	}
	return undefined;
}

function normalizeHeaders(headers: Record<string, string>): Map<string, string> {
	const normalized = new Map<string, string>();
	for (const [key, value] of Object.entries(headers)) {
		normalized.set(key.toLowerCase(), value);
	}
	return normalized;
}

function getNumericHeader(headers: ReadonlyMap<string, string>, aliases: string[], suffixes: string[]): number | undefined {
	for (const name of candidateHeaderNames(aliases, suffixes)) {
		const value = headers.get(name);
		if (value === undefined) continue;
		const parsed = Number(value.replace(/[^0-9.]/g, ""));
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function getResetHeader(headers: ReadonlyMap<string, string>, aliases: string[]): number | undefined {
	for (const name of candidateHeaderNames(aliases, ["reset", "resets", "reset-at", "resets-at", "reset-after"])) {
		const value = headers.get(name);
		if (value === undefined) continue;
		const parsed = parseResetTime(value);
		if (parsed !== undefined) return parsed;
	}
	return undefined;
}

function candidateHeaderNames(aliases: string[], suffixes: string[]): string[] {
	const names: string[] = [];
	for (const alias of aliases) {
		for (const suffix of suffixes) {
			names.push(`x-ratelimit-${suffix}-${alias}`);
			names.push(`x-ratelimit-${alias}-${suffix}`);
			names.push(`x-codex-${alias}-${suffix}`);
			names.push(`x-openai-codex-${alias}-${suffix}`);
		}
	}
	return names;
}

function parseResetTime(value: string): number | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;

	const numeric = Number(trimmed);
	if (Number.isFinite(numeric)) {
		if (numeric > 1_000_000_000_000) return numeric;
		if (numeric > 1_000_000_000) return numeric * 1000;
		return Date.now() + numeric * 1000;
	}

	const parsed = Date.parse(trimmed);
	return Number.isFinite(parsed) ? parsed : undefined;
}
