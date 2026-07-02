/**
 * opencode-usage — local OpenCode Go usage tracker.
 *
 * OpenCode Go (opencode.ai/docs/go) does **not** expose account usage via API
 * response headers or a usage endpoint (confirmed empirically: streaming +
 * non-stream chat completions and streaming Anthropic `/messages` return only
 * standard Cloudflare/SSE headers; no `x-opencode-*` usage headers; no
 * `/usage` route). Usage is shown in the OpenCode web console only.
 *
 * So this extension keeps a *local estimate* combining:
 *
 *   • observed cost — the dollar cost pi attaches to each assistant message
 *     (`message.usage.cost.total`) when the active provider is `opencode-go`,
 *     recorded to a deduplicated JSONL ledger;
 *   • a baseline — usage the user syncs from the OpenCode console, so the
 *     estimate tracks the console across machines/sessions sharing one Go
 *     subscription.
 *
 * It then shows rolling-5h / weekly / monthly usage with reset countdowns as:
 *   • a live, themed progress-bar widget below the editor
 *     (refreshed on `after_provider_response` / `session_start` / `model_select`
 *     and after each recorded `message_end`; cleared when leaving Go);
 *   • a compact footer status line; and
 *   • a `/usage` command (show | sync | status | reset | set-baseline | set-anchor).
 *
 * OpenCode Go documented limits: rolling 5h $12 · weekly $30 · monthly $60.
 *
 * Local estimate only — no network calls. The store lives at
 * `~/.pi/agent/opencode-usage/` (config.json + ledger.jsonl); override with
 * `PI_OPENCODE_USAGE_DIR`.
 *
 * Based on the headerless approach in github.com/Fatih0234/pi-opencode-go-usage.
 */

import { appendFile, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	cloneDefaultConfig,
	computeUsageReport,
	formatRelativeTime,
	formatUsd,
	getCalendarMonthBoundsUtc,
	getMonthlyBoundsUtc,
	getWeekBoundsUtc,
	isActiveProvider,
	isValidUsageEvent,
	makeDedupeKey,
	mergeConfig,
	parseDurationMs,
	parseUsageAmount,
	renderReport,
	renderStatus,
	renderWidget,
	safeNumber,
	type GoUsageConfig,
	type UsageLedgerEvent,
} from "./lib.js";

/**
 * OpenCode Go model pricing ($ per 1M tokens).
 * Source: models.dev/api.json — verified for opencode.ai/go models.
 */
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }> = {
	// ZAI / GLM family
	"glm-5.2": { input: 1.2, output: 4.1, cacheRead: 0.2 },
	"glm-5.1": { input: 1.0, output: 3.2, cacheRead: 0.1 },
	"glm-4.7-flash": { input: 0.1, output: 0.5, cacheRead: 0.1 },
	// Moonshot / Kimi family
	"kimi-k2.7-code": { input: 0.95, output: 4.0, cacheRead: 0.95 },
	"kimi-k2.6": { input: 0.68, output: 3.15, cacheRead: 0.07 },
	// MiniMax family
	"minimax-m3": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
	"minimax-m2.7": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
	"minimax-m2.5": { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.375 },
	// MiMo family (Xiaomi)
	"mimo-v2.5-pro": { input: 0, output: 0 },
	"mimo-v2.5": { input: 0, output: 0 },
	// Qwen family
	"qwen3.7-max": { input: 0, output: 0 },
	"qwen3.7-plus": { input: 0, output: 0 },
	"qwen3.6-plus": { input: 0, output: 0 },
	// DeepSeek family
	"deepseek-v4-pro": { input: 1.74, output: 3.48, cacheRead: 0.02 },
	"deepseek-v4-flash": { input: 0, output: 0 },
};

/** Calculate cost in USD from token usage counters. */
function calculateCostFromTokens(usage: Record<string, unknown>, modelId: string): number {
	const pricing = MODEL_PRICING[modelId.toLowerCase()];
	if (!pricing) return 0;

	return (
		(safeNumber(usage.input, 0) / 1_000_000) * pricing.input +
		(safeNumber(usage.output, 0) / 1_000_000) * pricing.output +
		(safeNumber(usage.cacheRead, 0) / 1_000_000) * (pricing.cacheRead ?? 0) +
		(safeNumber(usage.cacheWrite, 0) / 1_000_000) * (pricing.cacheWrite ?? 0)
	);
}

const WIDGET_KEY = "opencode-usage";
const STATUS_KEY = "opencode-usage";
const WIDGET_PLACEMENT = "belowEditor" as const;

type Store = {
	dir: string;
	configPath: string;
	ledgerPath: string;
};

function getStore(): Store {
	const dir = process.env.PI_OPENCODE_USAGE_DIR || path.join(homedir(), ".pi", "agent", "opencode-usage");
	return {
		dir,
		configPath: path.join(dir, "config.json"),
		ledgerPath: path.join(dir, "ledger.jsonl"),
	};
}

async function ensureStore(): Promise<Store> {
	const store = getStore();
	await mkdir(store.dir, { recursive: true });
	if (!existsSync(store.configPath)) {
		await writeJsonAtomic(store.configPath, cloneDefaultConfig());
	}
	if (!existsSync(store.ledgerPath)) {
		await writeFile(store.ledgerPath, "", "utf8");
	}
	return store;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(temp, filePath);
}

async function loadConfig(): Promise<GoUsageConfig> {
	const store = await ensureStore();
	try {
		const raw = await readFile(store.configPath, "utf8");
		return mergeConfig(JSON.parse(raw));
	} catch {
		const config = cloneDefaultConfig();
		await writeJsonAtomic(store.configPath, config);
		return config;
	}
}

async function saveConfig(config: GoUsageConfig): Promise<void> {
	const store = await ensureStore();
	await writeJsonAtomic(store.configPath, mergeConfig(config));
}

async function readLedger(): Promise<{ events: UsageLedgerEvent[]; invalidLineCount: number }> {
	const store = await ensureStore();
	// NOTE: The ledger grows unbounded over time. Production use should add pruning
	// (e.g. keep only last N days or truncate after each monthly reset).
	const raw = await readFile(store.ledgerPath, "utf8").catch(() => "");
	const events: UsageLedgerEvent[] = [];
	let invalidLineCount = 0;

	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (isValidUsageEvent(parsed)) events.push(parsed);
			else invalidLineCount++;
		} catch {
			invalidLineCount++;
		}
	}

	events.sort((a, b) => new Date(a.timestampIso).getTime() - new Date(b.timestampIso).getTime());
	return { events, invalidLineCount };
}

async function appendUsageEventDeduped(event: UsageLedgerEvent): Promise<boolean> {
	const store = await ensureStore();
	const { events } = await readLedger();
	if (events.some((existing) => existing.dedupeKey === event.dedupeKey)) return false;
	// TOCTOU race: another process could append between the dedupe check above and this write.
	// Acceptable for local single-user usage tracking; a production system would use file locking
	// or an atomic compare-and-swap append.
	await appendFile(store.ledgerPath, `${JSON.stringify(event)}\n`, "utf8");
	return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function usageEventFromAssistantMessage(message: any, ctx: ExtensionContext): UsageLedgerEvent | undefined {
	// Try to use cost from message first (if pi calculated it)
	let costUsd = Number(message?.usage?.cost?.total ?? 0);
	
	// If cost is 0/missing, calculate from tokens using model pricing
	if (!Number.isFinite(costUsd) || costUsd <= 0) {
		const modelId = String(message.model ?? "");
		const usage = message.usage ?? {};
		costUsd = calculateCostFromTokens(usage, modelId);
	}
	
	// Still 0? Skip this event (free model or unknown pricing)
	if (!Number.isFinite(costUsd) || costUsd <= 0) return undefined;

	const timestampMs = Number(message.timestamp);
	const timestampIso = Number.isFinite(timestampMs) && timestampMs > 0
		? new Date(timestampMs).toISOString()
		: new Date().toISOString();

	const provider = String(message.provider ?? "");
	const model = String(message.model ?? "");
	const usage = message.usage ?? {};
	const responseId = typeof message.responseId === "string" ? message.responseId : undefined;

	const dedupeKey = responseId
		? makeDedupeKey({ responseId, provider, model })
		: makeDedupeKey({
			provider,
			model,
			timestampIso,
			stopReason: message.stopReason,
			usage: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				totalTokens: usage.totalTokens,
				cost: usage.cost,
			},
		});

	return {
		version: 1,
		kind: "usage",
		dedupeKey,
		timestampIso,
		provider,
		model,
		api: typeof message.api === "string" ? message.api : undefined,
		costUsd,
		usage,
		sessionFile: ctx.sessionManager.getSessionFile(),
		responseId,
		stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
	};
}

function sendReport(pi: ExtensionAPI, content: string): void {
	pi.sendMessage({
		customType: WIDGET_KEY,
		content,
		display: true,
		details: { generatedAt: new Date().toISOString() },
	});
}

function parseKeyValueArgs(args: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of args.split(/\s+/).filter(Boolean)) {
		const idx = part.indexOf("=");
		if (idx === -1) continue;
		const key = part.slice(0, idx).trim();
		const value = part.slice(idx + 1).trim();
		if (key) out[key] = value;
	}
	return out;
}

async function buildReport() {
	const store = await ensureStore();
	const config = await loadConfig();
	const { events, invalidLineCount } = await readLedger();
	const report = computeUsageReport(config, events, new Date(), invalidLineCount);
	return { store, config, events, report };
}

// ---------------------------------------------------------------------------
// Widget + footer status
// ---------------------------------------------------------------------------

function currentProvider(ctx: ExtensionContext): string {
	return ctx.model?.provider ?? "";
}

async function refreshUi(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const config = await loadConfig();
	const active = isActiveProvider(currentProvider(ctx), config);
	if (!active) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	const { report } = await buildReport();
	ctx.ui.setWidget(WIDGET_KEY, renderWidget(report, ctx.ui.theme), { placement: WIDGET_PLACEMENT });

	// Compact one-line footer: rolling used / limit and its reset countdown.
	const r = report.rolling;
	ctx.ui.setStatus(
		STATUS_KEY,
		`Go ${formatUsd(r.usedUsd)}/${formatUsd(r.limitUsd)} · ${r.percent}% · resets ${formatRelativeTime(r.endIso, report.nowIso)}`,
	);
}

function clearUi(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget(WIDGET_KEY, undefined);
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

// ---------------------------------------------------------------------------
// /usage command handlers
// ---------------------------------------------------------------------------

async function handleShow(pi: ExtensionAPI): Promise<void> {
	const { report } = await buildReport();
	sendReport(pi, renderReport(report));
}

async function handleStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const { store, config, events, report } = await buildReport();
	sendReport(
		pi,
		renderStatus({
			storeDir: store.dir,
			configPath: store.configPath,
			ledgerPath: store.ledgerPath,
			config,
			report,
			currentProvider: ctx.model?.provider,
			currentModel: ctx.model?.id,
			lastEvent: events.at(-1),
		}),
	);
}

async function handleSetAnchor(pi: ExtensionAPI, argText: string): Promise<void> {
	const raw = argText.trim();
	const date = new Date(raw);
	if (!raw || Number.isNaN(date.getTime())) {
		sendReport(pi, "Usage: /usage set-anchor 2026-05-15T14:20:00Z");
		return;
	}
	const config = await loadConfig();
	config.monthlyAnchorIso = date.toISOString();
	await saveConfig(config);
	sendReport(pi, `OpenCode Go monthly anchor set to ${date.toISOString()}.`);
}

function computeBaselineWindowStarts(config: GoUsageConfig, now: Date) {
	const week = getWeekBoundsUtc(now);
	const month = config.monthlyAnchorIso
		? getMonthlyBoundsUtc(now, new Date(config.monthlyAnchorIso))
		: getCalendarMonthBoundsUtc(now);
	return { weekStartIso: week.start.toISOString(), monthStartIso: month.start.toISOString() };
}

async function handleSetBaseline(pi: ExtensionAPI, argText: string): Promise<void> {
	const args = parseKeyValueArgs(argText);
	const config = await loadConfig();
	const now = new Date();
	const { weekStartIso, monthStartIso } = computeBaselineWindowStarts(config, now);

	const rollingRaw = args.rollingUsedUsd ?? args.rolling;
	const weeklyRaw = args.weeklyUsedUsd ?? args.weekly;
	const monthlyRaw = args.monthlyUsedUsd ?? args.monthly;

	try {
		const rolling = parseUsageAmount(rollingRaw, config.limitsUsd.rolling) ?? 0;
		const weekly = parseUsageAmount(weeklyRaw, config.limitsUsd.weekly) ?? 0;
		const monthly = parseUsageAmount(monthlyRaw, config.limitsUsd.monthly) ?? 0;

		const rollingResetMs = parseDurationMs(args.rollingResetIn ?? args.rollingReset ?? args.resetIn);
		const rollingExpiresAtIso = rollingResetMs
			? new Date(now.getTime() + rollingResetMs).toISOString()
			: new Date(now.getTime() + config.rollingWindowHours * 60 * 60 * 1000).toISOString();

		config.baseline = {
			timestampIso: now.toISOString(),
			rollingUsedUsd: rolling,
			rollingExpiresAtIso,
			weeklyUsedUsd: weekly,
			weeklyWindowStartIso: weekStartIso,
			monthlyUsedUsd: monthly,
			monthlyWindowStartIso: monthStartIso,
		};

		if (args.monthlyAnchorIso) {
			const anchor = new Date(args.monthlyAnchorIso);
			if (Number.isNaN(anchor.getTime())) throw new Error(`Invalid monthlyAnchorIso: ${args.monthlyAnchorIso}`);
			config.monthlyAnchorIso = anchor.toISOString();
		}

		await saveConfig(config);
		sendReport(
			pi,
			[
				"OpenCode Go baseline saved.",
				"",
				`Rolling baseline: ${formatUsd(rolling)} until ${rollingExpiresAtIso}`,
				`Weekly baseline: ${formatUsd(weekly)} for week starting ${weekStartIso}`,
				`Monthly baseline: ${formatUsd(monthly)} for window starting ${monthStartIso}`,
				`Monthly anchor: ${config.monthlyAnchorIso ?? "not configured"}`,
			].join("\n"),
		);
	} catch (error) {
		sendReport(pi, `Could not set baseline: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function handleSync(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const config = await loadConfig();
	if (!ctx.hasUI) {
		sendReport(
			pi,
			"Interactive UI is not available. Use: /usage set-baseline monthly=70% weekly=20% rolling=5% rollingResetIn=2h40m",
		);
		return;
	}

	const rollingRaw = await ctx.ui.input("OpenCode Go rolling 5h usage now", "Example: 5%, $0.60, 0.60, or blank");
	const weeklyRaw = await ctx.ui.input("OpenCode Go weekly usage now", "Example: 20%, $6, 6, or blank");
	const monthlyRaw = await ctx.ui.input("OpenCode Go monthly usage now", "Example: 70%, $42, 42, or blank");
	const rollingResetRaw = await ctx.ui.input("Rolling reset ETA (optional)", "Example: 2h 40m, 45m, or blank");
	const anchorRaw = await ctx.ui.input("Monthly subscription anchor ISO (optional)", "Example: 2026-05-15T14:20:00Z");

	const now = new Date();
	const { weekStartIso, monthStartIso } = computeBaselineWindowStarts(config, now);
	const rolling = parseUsageAmount(rollingRaw, config.limitsUsd.rolling) ?? 0;
	const weekly = parseUsageAmount(weeklyRaw, config.limitsUsd.weekly) ?? 0;
	const monthly = parseUsageAmount(monthlyRaw, config.limitsUsd.monthly) ?? 0;
	const rollingResetMs = parseDurationMs(rollingResetRaw);
	config.baseline = {
		timestampIso: now.toISOString(),
		rollingUsedUsd: rolling,
		rollingExpiresAtIso: rollingResetMs
			? new Date(now.getTime() + rollingResetMs).toISOString()
			: new Date(now.getTime() + config.rollingWindowHours * 60 * 60 * 1000).toISOString(),
		weeklyUsedUsd: weekly,
		weeklyWindowStartIso: weekStartIso,
		monthlyUsedUsd: monthly,
		monthlyWindowStartIso: monthStartIso,
	};

	if (anchorRaw?.trim()) {
		const anchor = new Date(anchorRaw.trim());
		if (!Number.isNaN(anchor.getTime())) {
			config.monthlyAnchorIso = anchor.toISOString();
		} else {
			ctx.ui.notify("opencode-usage: ignored invalid monthly anchor", "warning");
		}
	}

	await saveConfig(config);

	sendReport(
		pi,
		[
			"OpenCode Go baseline synced.",
			"",
			`Rolling baseline: ${formatUsd(rolling)}`,
			`Weekly baseline: ${formatUsd(weekly)}`,
			`Monthly baseline: ${formatUsd(monthly)}`,
			`Monthly anchor: ${config.monthlyAnchorIso ?? "not configured"}`,
			"",
			"Run /usage to view the estimate.",
		].join("\n"),
	);
}

async function handleReset(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.hasUI) {
		const ok = await ctx.ui.confirm(
			"Reset OpenCode Go local usage tracker?",
			"This archives the local ledger and clears the baseline. It does not affect OpenCode.",
		);
		if (!ok) return;
	}

	const store = await ensureStore();
	const archivePath = `${store.ledgerPath}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
	if (existsSync(store.ledgerPath)) {
		await copyFile(store.ledgerPath, archivePath).catch(() => undefined);
	}
	await writeFile(store.ledgerPath, "", "utf8");

	const config = await loadConfig();
	config.baseline = cloneDefaultConfig().baseline;
	await saveConfig(config);

	sendReport(pi, `OpenCode Go local usage tracker reset.\nArchived previous ledger to: ${archivePath}`);
}

const SUBCOMMANDS = ["sync", "status", "reset", "set-baseline", "set-anchor"] as const;

function usageHelp(): string {
	return [
		"Unknown /usage command.",
		"",
		"Usage:",
		"/usage",
		"/usage sync",
		"/usage status",
		"/usage reset",
		"/usage set-baseline monthly=70% weekly=20% rolling=5% [rollingResetIn=2h40m]",
		"/usage set-anchor 2026-05-15T14:20:00Z",
	].join("\n");
}

export default function opencodeUsageExtension(pi: ExtensionAPI) {
	// Warm-create the local store, but never block extension load on it.
	ensureStore().catch(() => undefined);

	// Record observed cost from each assistant message whose provider is Go.
	pi.on("message_end", async (event, ctx) => {
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const message = (event.message as any) as Record<string, unknown>;
			if (!message || message.role !== "assistant") return;

			const config = await loadConfig();
			if (!isActiveProvider(message.provider, config)) return;

			const usageEvent = usageEventFromAssistantMessage(message, ctx);
			if (!usageEvent) return;

			const appended = await appendUsageEventDeduped(usageEvent);
			if (appended) {
				ctx.ui.setStatus(STATUS_KEY, `Go +${formatUsd(usageEvent.costUsd)}`);
			}
		} catch (error) {
			ctx.ui.notify(
				`opencode-usage: failed to record usage: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
		// Refresh the widget/footer after recording (and on every message_end,
		// which restores the compact footer from the transient "+$x" pulse).
		await refreshUi(ctx).catch(() => undefined);
	});

	// Live pulse while a Go response is streaming.
	pi.on("after_provider_response", async (_event, ctx) => {
		await refreshUi(ctx).catch(() => undefined);
	});

	// Render on entering Go; clear when leaving Go.
	pi.on("model_select", async (_event, ctx) => {
		await refreshUi(ctx).catch(() => undefined);
	});

	pi.on("session_start", async (_event, ctx) => {
		await refreshUi(ctx).catch(() => undefined);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearUi(ctx);
	});

	pi.registerCommand("usage", {
		description: "Show local OpenCode Go usage estimate, sync a baseline, or inspect tracker status.",
		getArgumentCompletions: (prefix: string) => {
			const items = SUBCOMMANDS.map((value) => ({ value, label: value }));
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length ? filtered : null;
		},
		async handler(args: string, ctx: ExtensionCommandContext) {
			const trimmed = args.trim();
			const [subcommand, ...rest] = trimmed.split(/\s+/);
			const restText = rest.join(" ");

			try {
				if (!trimmed) return handleShow(pi);
				if (subcommand === "sync") return handleSync(pi, ctx);
				if (subcommand === "status") return handleStatus(pi, ctx);
				if (subcommand === "reset") return handleReset(pi, ctx);
				if (subcommand === "set-baseline") return handleSetBaseline(pi, restText);
				if (subcommand === "set-anchor") return handleSetAnchor(pi, restText);
				sendReport(pi, usageHelp());
			} catch (error) {
				ctx.ui.notify(`opencode-usage error: ${error instanceof Error ? error.message : String(error)}`, "error");
			}

			// Keep the widget/footer in sync after a command mutates config/baseline.
			await refreshUi(ctx).catch(() => undefined);
		},
	});
}
