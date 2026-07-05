import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

export type QuotaBucket = {
	used?: number;
	limit?: number;
	remaining?: number;
	percent?: number;
	resetAt?: number;
	window?: "5min" | "5h" | "12h" | "24h" | "7d" | "30d";
};

export type CodexQuota = {
	session?: QuotaBucket;
	weekly?: QuotaBucket;
	credits?: {
		balance: number;
		unlimited: boolean;
	};
};

type RolloutFile = {
	path: string;
	mtimeMs: number;
};

export type CodexRateLimitsEvent = {
	rateLimits: Record<string, unknown>;
	path: string;
	lineNumber: number;
	fileMtimeMs: number;
	timestampMs?: number;
};

/**
 * Read Codex quota from the freshest rollout JSONL data in a sessions directory.
 */
export function readCodexQuotaFromDirectory(dir: string): CodexQuota {
	const rateLimits = readLatestCodexRateLimits(dir);
	return rateLimits ? parseCodexRateLimits(rateLimits) : {};
}

export function readLatestCodexRateLimits(dir: string): Record<string, unknown> | undefined {
	return findLatestCodexRateLimitsEvent(dir)?.rateLimits;
}

export function findLatestCodexRateLimitsEvent(dir: string): CodexRateLimitsEvent | undefined {
	let latest: CodexRateLimitsEvent | undefined;

	for (const file of findCodexRolloutFiles(dir)) {
		for (const event of readRateLimitsEvents(file)) {
			if (!latest || isNewerRateLimitsEvent(event, latest)) {
				latest = event;
			}
		}
	}

	return latest;
}

function findCodexRolloutFiles(dir: string): RolloutFile[] {
	try {
		return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) return findCodexRolloutFiles(path);
			if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) return [];

			try {
				return [{ path, mtimeMs: statSync(path).mtimeMs }];
			} catch {
				return [];
			}
		});
	} catch {
		return [];
	}
}

function readRateLimitsEvents(file: RolloutFile): CodexRateLimitsEvent[] {
	const events: CodexRateLimitsEvent[] = [];

	try {
		const lines = readFileSync(file.path, "utf-8").split("\n");
		lines.forEach((line, index) => {
			if (!line.includes("rate_limits")) return;
			const event = parseRateLimitsLine(line, file, index + 1);
			if (event) events.push(event);
		});
	} catch {
		return [];
	}

	return events;
}

function parseRateLimitsLine(
	line: string,
	file: RolloutFile,
	lineNumber: number,
): CodexRateLimitsEvent | undefined {
	try {
		const event = JSON.parse(line) as unknown;
		if (!isRecord(event)) return undefined;
		const payload = event.payload;
		if (!isRecord(payload)) return undefined;
		const rateLimits = payload.rate_limits;
		if (!isRecord(rateLimits) || !hasRateLimitBuckets(rateLimits)) return undefined;

		return {
			rateLimits,
			path: file.path,
			lineNumber,
			fileMtimeMs: file.mtimeMs,
			timestampMs: parseEventTimestampMs(event, payload),
		};
	} catch {
		return undefined;
	}
}

function hasRateLimitBuckets(rateLimits: Record<string, unknown>): boolean {
	return isRecord(rateLimits.primary) || isRecord(rateLimits.secondary) || isRecord(rateLimits.credits);
}

function parseEventTimestampMs(
	event: Record<string, unknown>,
	payload: Record<string, unknown>,
): number | undefined {
	return parseTimestampMs(event.timestamp)
		?? parseTimestampMs(event.created_at)
		?? parseTimestampMs(event.createdAt)
		?? parseTimestampMs(payload.timestamp)
		?? parseTimestampMs(payload.created_at)
		?? parseTimestampMs(payload.createdAt);
}

function parseTimestampMs(value: unknown): number | undefined {
	if (typeof value === "number") return normalizeEpochMs(value);
	if (typeof value !== "string") return undefined;

	const trimmed = value.trim();
	if (!trimmed) return undefined;

	if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
		return normalizeEpochMs(Number.parseFloat(trimmed));
	}

	const parsed = Date.parse(trimmed);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeEpochMs(value: number): number | undefined {
	if (!Number.isFinite(value)) return undefined;
	return value > 1_000_000_000_000 ? value : value * 1000;
}

function isNewerRateLimitsEvent(
	candidate: CodexRateLimitsEvent,
	current: CodexRateLimitsEvent,
): boolean {
	const candidateFreshnessMs = candidate.timestampMs ?? candidate.fileMtimeMs;
	const currentFreshnessMs = current.timestampMs ?? current.fileMtimeMs;
	if (candidateFreshnessMs !== currentFreshnessMs) {
		return candidateFreshnessMs > currentFreshnessMs;
	}

	if (candidate.fileMtimeMs !== current.fileMtimeMs) {
		return candidate.fileMtimeMs > current.fileMtimeMs;
	}

	if (candidate.path !== current.path) {
		return candidate.path > current.path;
	}

	return candidate.lineNumber > current.lineNumber;
}

/**
 * Parse raw rate_limits JSON into our CodexQuota structure.
 */
export function parseCodexRateLimits(raw: Record<string, unknown>): CodexQuota {
	const result: CodexQuota = {};
	const credits = raw.credits;
	const primary = raw.primary;
	const secondary = raw.secondary;

	// Credits-based quota (when rate limited)
	if (isRecord(credits)) {
		result.credits = {
			balance: parseFiniteNumber(credits.balance) ?? 0,
			unlimited: credits.unlimited === true,
		};
	}

	// Window-based limits (session + weekly)
	if (isRecord(primary)) result.session = parseCodexBucket(primary);
	if (isRecord(secondary)) result.weekly = parseCodexBucket(secondary);

	return result;
}

function parseCodexBucket(raw: Record<string, unknown>): QuotaBucket {
	const usedPercent = parseFiniteNumber(raw.used_percent);
	const resetAt = parseFiniteNumber(raw.resets_at);
	const windowMinutes = parseFiniteNumber(raw.window_minutes);

	return {
		used: usedPercent,
		remaining: usedPercent === undefined ? undefined : 100 - clampPercent(usedPercent),
		// Historical cache entries use `percent`; keep it as usage, not remaining.
		percent: usedPercent,
		resetAt: resetAt === undefined ? undefined : Math.floor(resetAt * 1000),
		window: classifyWindow(windowMinutes),
	};
}

function parseFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number.parseFloat(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function bucketRemainingPercent(bucket: QuotaBucket): number | undefined {
	if (bucket.remaining !== undefined) return clampPercent(bucket.remaining);
	if (bucket.percent !== undefined) return 100 - clampPercent(bucket.percent);
	if (bucket.used !== undefined && bucket.limit !== undefined && bucket.limit > 0) {
		return 100 - clampPercent((bucket.used / bucket.limit) * 100);
	}
	return undefined;
}

function clampPercent(percent: number): number {
	return Math.max(0, Math.min(100, percent));
}
