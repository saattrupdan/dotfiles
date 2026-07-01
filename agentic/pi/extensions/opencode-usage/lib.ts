/**
 * opencode-usage — data layer.
 *
 * OpenCode Go does **not** expose account usage via API response headers or a
 * usage endpoint (confirmed empirically against opencode.ai/zen/go). Usage is
 * surfaced only in the OpenCode web console. So this tracker keeps a *local*
 * estimate by:
 *
 *   1. Recording the per-response dollar cost that pi attaches to each
 *      assistant message (`message.usage.cost.total`) when the active provider
 *      is `opencode-go`, deduplicated by response id (or a usage fingerprint).
 *   2. Combining that observed ledger with an optional *baseline* the user
 *      syncs from the OpenCode console, so the estimate tracks the console
 *      even across machines/sessions that share the same Go subscription.
 *
 * Assumed assistant-message usage shape (read from pi's `message_end` event):
 *
 *   message: {
 *     role: "assistant",
 *     provider: string,            // e.g. "opencode-go"
 *     model:    string,
 *     api?:     string,
 *     responseId?: string,
 *     stopReason?: string,
 *     timestamp: number,
 *     usage: {
 *       input?:     number,        // prompt tokens
 *       output?:    number,        // completion tokens
 *       cacheRead?: number,
 *       cacheWrite?:number,
 *       totalTokens?: number,
 *       cost: { input?, output?, cacheRead?, cacheWrite?, total: number },
 *     },
 *   }
 *
 * OpenCode Go documented limits (USD, per opencode.ai/docs/go):
 *   rolling 5h window: $12 · weekly: $30 · monthly: $60.
 *
 * The monthly window is anchored to the subscription date if provided
 * (`monthlyAnchorIso`); otherwise it falls back to the calendar month and is
 * flagged approximate. Rolling & weekly are computed deterministically.
 */

import { createHash } from "node:crypto";

import type { Theme } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UsageCost = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	total?: number;
};

export type UsageSnapshot = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: UsageCost;
};

export type UsageLedgerEvent = {
	version: 1;
	kind: "usage";
	dedupeKey: string;
	timestampIso: string;
	provider: string;
	model: string;
	api?: string;
	costUsd: number;
	usage: UsageSnapshot;
	sessionFile?: string;
	responseId?: string;
	stopReason?: string;
};

export type Baseline = {
	timestampIso: string | null;
	rollingUsedUsd: number;
	rollingExpiresAtIso: string | null;
	weeklyUsedUsd: number;
	weeklyWindowStartIso: string | null;
	monthlyUsedUsd: number;
	monthlyWindowStartIso: string | null;
};

export type GoUsageConfig = {
	version: 1;
	providerFilters: string[];
	limitsUsd: {
		rolling: number;
		weekly: number;
		monthly: number;
	};
	rollingWindowHours: number;
	monthlyAnchorIso: string | null;
	baseline: Baseline;
};

export type WindowUsage = {
	label: string;
	usedUsd: number;
	limitUsd: number;
	observedUsd: number;
	baselineUsd: number;
	percent: number;
	startIso: string;
	endIso: string;
	exact: boolean;
	note?: string;
};

export type UsageReport = {
	nowIso: string;
	rolling: WindowUsage;
	weekly: WindowUsage;
	monthly: WindowUsage;
	totalObservedUsd: number;
	eventCount: number;
	invalidLedgerLineCount: number;
	warnings: string[];
};

// ---------------------------------------------------------------------------
// Defaults & config helpers
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: GoUsageConfig = {
	version: 1,
	providerFilters: ["opencode-go"],
	limitsUsd: {
		rolling: 12,
		weekly: 30,
		monthly: 60,
	},
	rollingWindowHours: 5,
	monthlyAnchorIso: null,
	baseline: {
		timestampIso: null,
		rollingUsedUsd: 0,
		rollingExpiresAtIso: null,
		weeklyUsedUsd: 0,
		weeklyWindowStartIso: null,
		monthlyUsedUsd: 0,
		monthlyWindowStartIso: null,
	},
};

export function cloneDefaultConfig(): GoUsageConfig {
	return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as GoUsageConfig;
}

export function mergeConfig(input: Partial<GoUsageConfig> | undefined): GoUsageConfig {
	const defaults = cloneDefaultConfig();
	if (!input || typeof input !== "object") return defaults;
	return {
		...defaults,
		...input,
		providerFilters: Array.isArray(input.providerFilters) ? input.providerFilters : defaults.providerFilters,
		limitsUsd: { ...defaults.limitsUsd, ...(input.limitsUsd ?? {}) },
		baseline: { ...defaults.baseline, ...(input.baseline ?? {}) },
	};
}

// ---------------------------------------------------------------------------
// Small formatting / arithmetic helpers
// ---------------------------------------------------------------------------

export function safeNumber(value: unknown, fallback = 0): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

export function clampPercent(used: number, limit: number): number {
	if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
	return Math.max(0, Math.min(999, Math.floor((used / limit) * 100)));
}

export function formatUsd(value: number): string {
	if (!Number.isFinite(value)) return "$0.00";
	const s = value.toFixed(4);
	const trimmed = s.replace(/0+$/, "");
	const dotIdx = trimmed.indexOf(".");
	const decimalPlaces = dotIdx === -1 ? 0 : trimmed.length - dotIdx - 1;
	if (decimalPlaces < 2) return `$${value.toFixed(2)}`;
	return `$${trimmed}`;
}

export function formatDate(iso: string): string {
	return new Date(iso).toISOString().replace(".000Z", "Z");
}

export function formatRelativeTime(endIso: string, nowIso: string): string {
	const diffMs = new Date(endIso).getTime() - new Date(nowIso).getTime();
	if (diffMs <= 0) return "now";
	if (diffMs < 60_000) return "<1m";

	const totalMinutes = Math.floor(diffMs / 60_000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;

	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (days === 0 && minutes > 0) parts.push(`${minutes}m`);

	if (parts.length === 0) return "<1m";
	return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Window boundaries (UTC, deterministic)
// ---------------------------------------------------------------------------

export function getWeekBoundsUtc(now: Date): { start: Date; end: Date } {
	// Monday-anchored week.
	const offset = (now.getUTCDay() + 6) % 7;
	const start = new Date(now);
	start.setUTCDate(now.getUTCDate() - offset);
	start.setUTCHours(0, 0, 0, 0);
	const end = new Date(start);
	end.setUTCDate(start.getUTCDate() + 7);
	return { start, end };
}

export function getCalendarMonthBoundsUtc(now: Date): { start: Date; end: Date } {
	const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
	const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
	return { start, end };
}

export function getMonthlyBoundsUtc(now: Date, subscribed: Date): { start: Date; end: Date } {
	const day = subscribed.getUTCDate();
	const hh = subscribed.getUTCHours();
	const mm = subscribed.getUTCMinutes();
	const ss = subscribed.getUTCSeconds();
	const ms = subscribed.getUTCMilliseconds();

	function anchor(year: number, month: number): Date {
		const max = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
		return new Date(Date.UTC(year, month, Math.min(day, max), hh, mm, ss, ms));
	}

	function shift(year: number, month: number, delta: number): readonly [number, number] {
		const total = year * 12 + month + delta;
		return [Math.floor(total / 12), ((total % 12) + 12) % 12] as const;
	}

	let y = now.getUTCFullYear();
	let m = now.getUTCMonth();
	let start = anchor(y, m);
	if (start > now) {
		[y, m] = shift(y, m, -1);
		start = anchor(y, m);
	}
	const [ny, nm] = shift(y, m, 1);
	const end = anchor(ny, nm);
	return { start, end };
}

// ---------------------------------------------------------------------------
// Parsing helpers for the /usage command
// ---------------------------------------------------------------------------

export function parseUsageAmount(input: string | undefined | null, limitUsd: number): number | undefined {
	const raw = (input ?? "").trim();
	if (!raw) return undefined;

	const compact = raw.replace(/\s+/g, "");
	if (compact.endsWith("%")) {
		const pct = Number(compact.slice(0, -1));
		if (!Number.isFinite(pct) || pct < 0) throw new Error(`Invalid percentage: ${input}`);
		return (pct / 100) * limitUsd;
	}

	const normalized = compact.replace(/^\$/, "");
	const amount = Number(normalized);
	if (!Number.isFinite(amount) || amount < 0) throw new Error(`Invalid usage amount: ${input}`);
	return amount;
}

export function parseDurationMs(input: string | undefined | null): number | undefined {
	const raw = (input ?? "").trim().toLowerCase();
	if (!raw) return undefined;

	let total = 0;
	let matched = false;
	const re = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)/g;
	for (const match of raw.matchAll(re)) {
		matched = true;
		const value = Number(match[1]!);
		const unit = match[2]!;
		if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid duration: ${input}`);
		if (unit.startsWith("h")) total += value * 60 * 60 * 1000;
		else total += value * 60 * 1000;
	}

	if (!matched) {
		const minutes = Number(raw);
		if (!Number.isFinite(minutes) || minutes < 0) throw new Error(`Invalid duration: ${input}`);
		total = minutes * 60 * 1000;
	}

	return Math.round(total);
}

// ---------------------------------------------------------------------------
// Ledger / dedup
// ---------------------------------------------------------------------------

export function makeDedupeKey(parts: unknown): string {
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function isActiveProvider(provider: unknown, config: GoUsageConfig): boolean {
	if (typeof provider !== "string") return false;
	return config.providerFilters.includes(provider);
}

export function isValidUsageEvent(value: unknown): value is UsageLedgerEvent {
	const e = value as Partial<UsageLedgerEvent>;
	return (
		!!e &&
		e.version === 1 &&
		e.kind === "usage" &&
		typeof e.dedupeKey === "string" &&
		typeof e.timestampIso === "string" &&
		typeof e.provider === "string" &&
		typeof e.model === "string" &&
		typeof e.costUsd === "number" &&
		Number.isFinite(e.costUsd)
	);
}

export function sumEvents(events: UsageLedgerEvent[], start: Date, end: Date): number {
	return events.reduce((sum, event) => {
		const t = new Date(event.timestampIso);
		if (Number.isNaN(t.getTime())) return sum;
		if (t >= start && t < end) return sum + event.costUsd;
		return sum;
	}, 0);
}

// ---------------------------------------------------------------------------
// Report computation
// ---------------------------------------------------------------------------

export function computeUsageReport(
	config: GoUsageConfig,
	events: UsageLedgerEvent[],
	now = new Date(),
	invalidLedgerLineCount = 0,
): UsageReport {
	const warnings: string[] = [];

	const rollingMs = config.rollingWindowHours * 60 * 60 * 1000;
	const rollingStart = new Date(now.getTime() - rollingMs);
	const rollingEnd = now;
	const observedRolling = sumEvents(events, rollingStart, rollingEnd);

	const baselineTimestamp = config.baseline.timestampIso ? new Date(config.baseline.timestampIso) : undefined;
	let rollingBaseline = 0;
	let rollingResetTime: Date | undefined;
	if (config.baseline.rollingUsedUsd > 0) {
		const explicitExpiry = config.baseline.rollingExpiresAtIso
			? new Date(config.baseline.rollingExpiresAtIso)
			: undefined;
		const derivedExpiry = baselineTimestamp ? new Date(baselineTimestamp.getTime() + rollingMs) : undefined;
		const expiry = explicitExpiry ?? derivedExpiry;
		if (expiry && expiry > now) {
			rollingBaseline = config.baseline.rollingUsedUsd;
			rollingResetTime = expiry;
		}
	}

	const week = getWeekBoundsUtc(now);
	const observedWeekly = sumEvents(events, week.start, week.end);
	const baselineWeeklyStart = config.baseline.weeklyWindowStartIso
		? new Date(config.baseline.weeklyWindowStartIso)
		: baselineTimestamp
			? getWeekBoundsUtc(baselineTimestamp).start
			: undefined;
	const weeklyBaseline =
		baselineWeeklyStart && baselineWeeklyStart.getTime() === week.start.getTime()
			? config.baseline.weeklyUsedUsd
			: 0;

	const monthlyExact = !!config.monthlyAnchorIso;
	const month = monthlyExact
		? getMonthlyBoundsUtc(now, new Date(config.monthlyAnchorIso as string))
		: getCalendarMonthBoundsUtc(now);
	if (!monthlyExact) {
		warnings.push("Monthly estimate is approximate because monthlyAnchorIso is not configured.");
	}
	const observedMonthly = sumEvents(events, month.start, month.end);
	const baselineMonthlyStart = config.baseline.monthlyWindowStartIso
		? new Date(config.baseline.monthlyWindowStartIso)
		: baselineTimestamp
			? (monthlyExact
				? getMonthlyBoundsUtc(baselineTimestamp, new Date(config.monthlyAnchorIso as string)).start
				: getCalendarMonthBoundsUtc(baselineTimestamp).start)
			: undefined;
	const monthlyBaseline =
		baselineMonthlyStart && baselineMonthlyStart.getTime() === month.start.getTime()
			? config.baseline.monthlyUsedUsd
			: 0;

	const totalObservedUsd = events.reduce((sum, event) => sum + event.costUsd, 0);

	function windowUsage(
		label: string,
		usedUsd: number,
		observedUsd: number,
		baselineUsd: number,
		limitUsd: number,
		start: Date,
		end: Date,
		exact: boolean,
		note?: string,
	): WindowUsage {
		return {
			label,
			usedUsd,
			observedUsd,
			baselineUsd,
			limitUsd,
			percent: clampPercent(usedUsd, limitUsd),
			startIso: start.toISOString(),
			endIso: end.toISOString(),
			exact,
			note,
		};
	}

	return {
		nowIso: now.toISOString(),
		rolling: windowUsage(
			"Rolling 5h",
			observedRolling + rollingBaseline,
			observedRolling,
			rollingBaseline,
			config.limitsUsd.rolling,
			rollingStart,
			rollingResetTime ?? rollingEnd,
			true,
			rollingBaseline > 0 ? "Rolling baseline active until its configured expiry." : undefined,
		),
		weekly: windowUsage(
			"Weekly",
			observedWeekly + weeklyBaseline,
			observedWeekly,
			weeklyBaseline,
			config.limitsUsd.weekly,
			week.start,
			week.end,
			true,
			"Week starts Monday 00:00 UTC.",
		),
		monthly: windowUsage(
			"Monthly",
			observedMonthly + monthlyBaseline,
			observedMonthly,
			monthlyBaseline,
			config.limitsUsd.monthly,
			month.start,
			month.end,
			monthlyExact,
			monthlyExact ? "Month anchored to configured subscription date." : "Calendar-month fallback.",
		),
		totalObservedUsd,
		eventCount: events.length,
		invalidLedgerLineCount,
		warnings,
	};
}

// ---------------------------------------------------------------------------
// Rendering: the /usage command report, the status debug view, and the
// live progress-bar widget.
// ---------------------------------------------------------------------------

function windowColor(theme: Theme, percent: number): (text: string) => string {
	if (percent >= 100) return (s) => theme.fg("error", s);
	if (percent >= 80) return (s) => theme.fg("warning", s);
	return (s) => theme.fg("accent", s);
}

/** A single-line progress bar segment, themed. Width is in cells. */
function barLine(theme: Theme, w: WindowUsage, width: number): string {
	const cells = Math.max(1, width);
	const filled = Math.round((clampPercent(w.usedUsd, w.limitUsd) / 100) * cells);
	const fillStr = "█".repeat(filled);
	const emptyStr = "░".repeat(Math.max(0, cells - filled));
	const color = windowColor(theme, clampPercent(w.usedUsd, w.limitUsd));
	return color(fillStr) + theme.fg("dim", emptyStr);
}

/** Multi-line progress-bar dashboard for the live setWidget. */
export function renderWidget(report: UsageReport, theme: Theme, width = 52): string[] {
	const labelW = 9;
	const barW = Math.max(10, Math.min(width - labelW - 1, 40));
	const lines: string[] = [];
	lines.push(theme.fg("muted", "OpenCode Go usage (local estimate)"));
	for (const w of [report.rolling, report.weekly, report.monthly]) {
		const pad = " ".repeat(Math.max(0, labelW - w.label.length));
		const approx = w.exact ? "" : "~";
		lines.push(
			`${theme.fg("text", w.label + pad)} ${barLine(theme, w, barW)} ${approx}${w.percent}% ${formatUsd(w.usedUsd)}/${formatUsd(w.limitUsd)}`,
		);
	}
	lines.push(
		theme.fg(
			"dim",
			`resets: rolling ${formatRelativeTime(report.rolling.endIso, report.nowIso)} · weekly ${formatRelativeTime(report.weekly.endIso, report.nowIso)} · monthly ${formatRelativeTime(report.monthly.endIso, report.nowIso)}`,
		),
	);
	return lines;
}

export function renderReport(report: UsageReport): string {
	const lines: string[] = [];

	function line(w: WindowUsage): string {
		const approximate = w.exact ? "" : " approx.";
		return `${w.label.padEnd(12)} ${formatUsd(w.usedUsd)} / ${formatUsd(w.limitUsd)} (${w.percent}%)${approximate} | observed ${formatUsd(w.observedUsd)} + baseline ${formatUsd(w.baselineUsd)} | Resets ${formatRelativeTime(w.endIso, report.nowIso)}`;
	}

	lines.push("OpenCode Go usage — local estimate");
	lines.push("");
	lines.push(line(report.rolling));
	lines.push(line(report.weekly));
	lines.push(line(report.monthly));
	lines.push("");
	lines.push(`Observed total in local ledger: ${formatUsd(report.totalObservedUsd)} across ${report.eventCount} event(s).`);
	if (report.invalidLedgerLineCount > 0) {
		lines.push(`Skipped ${report.invalidLedgerLineCount} malformed ledger line(s).`);
	}
	for (const warning of report.warnings) {
		lines.push(`Warning: ${warning}`);
	}
	lines.push("");
	lines.push("Important: this is a local estimate only. The OpenCode console may differ if you used Go from another tool, machine, session, or before setting the baseline.");

	return lines.join("\n");
}

export function renderStatus(args: {
	storeDir: string;
	configPath: string;
	ledgerPath: string;
	config: GoUsageConfig;
	report: UsageReport;
	currentProvider?: string;
	currentModel?: string;
	lastEvent?: UsageLedgerEvent;
}): string {
	const { storeDir, configPath, ledgerPath, config, report, currentProvider, currentModel, lastEvent } = args;
	return [
		"OpenCode Go usage tracker status",
		"",
		`Store directory: ${storeDir}`,
		`Config path: ${configPath}`,
		`Ledger path: ${ledgerPath}`,
		`Provider filters: ${config.providerFilters.join(", ")}`,
		`Current Pi provider/model: ${(currentProvider ?? "unknown")}/${currentModel ?? "unknown"}`,
		`Ledger events: ${report.eventCount}`,
		`Malformed ledger lines skipped: ${report.invalidLedgerLineCount}`,
		`Last event: ${lastEvent ? `${lastEvent.timestampIso} ${lastEvent.provider}/${lastEvent.model} ${formatUsd(lastEvent.costUsd)}` : "none"}`,
		`Monthly anchor: ${config.monthlyAnchorIso ?? "not configured; using calendar month fallback"}`,
		`Limits: rolling ${formatUsd(config.limitsUsd.rolling)}, weekly ${formatUsd(config.limitsUsd.weekly)}, monthly ${formatUsd(config.limitsUsd.monthly)}`,
		"",
		"Important: this tracker stores local usage only and does not send data over the network.",
	].join("\n");
}
