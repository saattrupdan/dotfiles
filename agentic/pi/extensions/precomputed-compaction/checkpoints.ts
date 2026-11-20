/** Branch-local checkpoint planning; only a completed, matching prefix may replace history. */
import { createHash } from "node:crypto";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import {
	buildSessionProjection,
	estimateTokens,
	type CompactionResult,
	type ProjectedSessionEntry,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export const CHECKPOINT_TYPE = "precomputed-compaction:checkpoint";
export const SUMMARY_SECTIONS = [
	"Goal", "Constraints", "Decisions", "Established facts", "Completed work",
	"Failed approaches", "Current position", "Evidence",
] as const;

export interface Config {
	enabled: boolean;
	provider: string;
	model: string;
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high";
	startTokens: number;
	updateTokens: number;
	keepRecentTokens: number;
	startHeadroomTokens: number;
	compactHeadroomTokens: number;
	maxChunkTokens: number;
	summaryMaxTokens: number;
	timeoutMs: number;
}

export const DEFAULT_CONFIG: Config = {
	enabled: true, provider: "openai-codex", model: "gpt-6-luna", thinkingLevel: "low",
	startTokens: 50_000, updateTokens: 15_000, keepRecentTokens: 30_000,
	startHeadroomTokens: 150_000, compactHeadroomTokens: 50_000,
	maxChunkTokens: 30_000, summaryMaxTokens: 8_000, timeoutMs: 180_000,
};

export interface Checkpoint {
	version: 1;
	baseCompactionId: string | null;
	firstKeptEntryId: string;
	prefixDigest: string;
	summary: string;
	provider: string;
	model: string;
	createdAt: number;
}

export interface History {
	branch: SessionEntry[];
	entries: ProjectedSessionEntry[];
	baseCompactionId: string | null;
	previousSummary?: string;
	startIndex: number;
	tokens: number;
}

export interface Work {
	checkpoint: Omit<Checkpoint, "summary" | "createdAt">;
	previousSummary?: string;
	entries: ProjectedSessionEntry[];
}

export function parseConfig(value: unknown): Config {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a configuration object");
	const config = { ...DEFAULT_CONFIG, ...value } as Config;
	if (typeof config.enabled !== "boolean") throw new Error("enabled must be a boolean");
	for (const key of ["provider", "model"] as const) {
		if (typeof config[key] !== "string" || !config[key].trim()) throw new Error(`${key} must be a nonempty string`);
	}
	if (!["off", "minimal", "low", "medium", "high"].includes(config.thinkingLevel)) throw new Error("Invalid thinkingLevel");
	for (const key of ["startTokens", "updateTokens", "keepRecentTokens", "startHeadroomTokens", "compactHeadroomTokens", "maxChunkTokens", "summaryMaxTokens", "timeoutMs"] as const) {
		if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`${key} must be a positive integer`);
	}
	if (config.keepRecentTokens >= config.startTokens || config.startHeadroomTokens <= config.compactHeadroomTokens) {
		throw new Error("Expected keepRecentTokens < startTokens and startHeadroomTokens > compactHeadroomTokens");
	}
	return config;
}

export function scaledConfig(config: Config, window: number, reserveTokens: number): Config & { compactAtTokens: number } {
	const startTokens = Math.max(config.startTokens, window - config.startHeadroomTokens);
	const compactAtTokens = Math.min(window - config.compactHeadroomTokens, window - reserveTokens - 1024);
	const scaled = {
		...config, startTokens, compactAtTokens,
		// Windows without room for preparation retain native compaction, including overflow recovery.
		enabled: config.enabled && Number.isFinite(window) && Number.isFinite(reserveTokens)
			&& startTokens < compactAtTokens,
	};
	const scale = Math.min(1, Math.max(0, window / 256_000));
	for (const key of ["updateTokens", "keepRecentTokens", "summaryMaxTokens"] as const) {
		scaled[key] = Math.max(1, Math.floor(config[key] * scale));
	}
	return scaled;
}

export function projectHistory(branch: SessionEntry[]): History {
	const entries = buildSessionProjection(branch).entries.filter(entry => entry.messages.length > 0);
	const compactionIndex = entries.findIndex(entry => entry.sourceEntry.type === "compaction");
	const compaction = entries[compactionIndex]?.sourceEntry;
	return {
		branch,
		entries,
		baseCompactionId: compaction?.type === "compaction" ? compaction.id : null,
		previousSummary: compaction?.type === "compaction" ? compaction.summary : undefined,
		startIndex: compactionIndex + 1,
		tokens: entries.reduce((sum, entry) => sum + entryTokens(entry), 0),
	};
}

function entryTokens(entry: ProjectedSessionEntry): number {
	return entry.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

function digestPrefix(history: History, cut: number): string {
	// Include edited model-visible content, not mutable usage statistics or state-only entries.
	const hash = createHash("sha256");
	for (const entry of history.entries.slice(0, cut)) {
		hash.update(JSON.stringify([entry.sourceEntry.id, entry.messages]));
	}
	return hash.digest("hex");
}

function cutIndex(history: History, checkpoint: Checkpoint): number {
	return history.entries.findIndex(entry => entry.sourceEntry.id === checkpoint.firstKeptEntryId);
}

function isCutPoint(entry: ProjectedSessionEntry): boolean {
	// An assistant tool-call message is kept with all of its following results.
	return entry.messages[0]?.role !== "toolResult" && entry.sourceEntry.type !== "compaction";
}

export function matchesHistory(history: History, checkpoint: Checkpoint): boolean {
	const cut = cutIndex(history, checkpoint);
	return checkpoint.baseCompactionId === history.baseCompactionId && cut > history.startIndex
		&& isCutPoint(history.entries[cut]) && checkpoint.prefixDigest === digestPrefix(history, cut);
}

export function latestCheckpoint(branch: SessionEntry[], history = projectHistory(branch)): Checkpoint | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== CHECKPOINT_TYPE) continue;
		const candidate = entry.data as Partial<Checkpoint> | undefined;
		if (candidate?.version !== 1 || typeof candidate.summary !== "string" || !candidate.summary.trim()
			|| typeof candidate.firstKeptEntryId !== "string" || typeof candidate.prefixDigest !== "string") continue;
		if (matchesHistory(history, candidate as Checkpoint)) return candidate as Checkpoint;
	}
	return undefined;
}

export function planCheckpoint(history: History, config: Config, checkpoint?: Checkpoint, contextTokens = history.tokens): Work | undefined {
	if (contextTokens < config.startTokens) return undefined;
	const from = checkpoint ? cutIndex(history, checkpoint) : history.startIndex;
	if (from < history.startIndex) return undefined;
	let tailTokens = 0;
	let target = history.entries.length;
	for (let i = history.entries.length - 1; i >= from; i--) {
		tailTokens += entryTokens(history.entries[i]);
		if (tailTokens >= config.keepRecentTokens) { target = i; break; }
	}
	if (target >= history.entries.length) return undefined;
	while (target > from && !isCutPoint(history.entries[target])) target--;
	if (target <= from) return undefined;
	const eligibleTokens = history.entries.slice(from, target).reduce((sum, entry) => sum + entryTokens(entry), 0);
	if (checkpoint && eligibleTokens < config.updateTokens) return undefined;

	// Drain a resumed long session in bounded, complete tool exchanges; never truncate source text.
	let chunkTokens = 0;
	let cut = from;
	for (let i = from; i < target; i++) {
		chunkTokens += entryTokens(history.entries[i]);
		if (chunkTokens > config.maxChunkTokens) break;
		if (isCutPoint(history.entries[i + 1])) cut = i + 1;
	}
	if (cut <= from) return undefined;
	return {
		checkpoint: {
			version: 1, baseCompactionId: history.baseCompactionId,
			firstKeptEntryId: history.entries[cut].sourceEntry.id,
			prefixDigest: digestPrefix(history, cut), provider: config.provider, model: config.model,
		},
		previousSummary: checkpoint?.summary ?? history.previousSummary,
		entries: history.entries.slice(from, cut),
	};
}

export function validateSummary(summary: string, maxTokens: number): void {
	if (!summary.trim() || summary.length > maxTokens * 4) throw new Error("Checkpoint is empty or exceeds its summary budget");
	for (const section of SUMMARY_SECTIONS) {
		if (!summary.includes(`## ${section}\n`)) throw new Error(`Checkpoint is missing section: ${section}`);
	}
}

export function checkpointCompaction(
	history: History, checkpoint: Checkpoint, tokensBefore: number, window: number, reserveTokens: number,
): CompactionResult | undefined {
	if (!matchesHistory(history, checkpoint)) return undefined;
	// Mirror appendCompaction: Pi folds all system deltas into a preserved system snapshot.
	// Counting only summary + tail would incorrectly treat the old system prompt/tools as freed.
	const systemMessage = getCurrentSystemMessage(history.entries.flatMap(entry => entry.messages));
	const projection = buildSessionProjection([...history.branch, {
		type: "compaction", id: "precomputed-compaction:estimate", parentId: history.branch.at(-1)?.id ?? null,
		timestamp: new Date(0).toISOString(), summary: checkpoint.summary,
		firstKeptEntryId: checkpoint.firstKeptEntryId, tokensBefore,
		...(systemMessage ? { systemMessage } : {}),
	}]);
	const overhead = Math.max(0, tokensBefore - history.tokens);
	const after = overhead + projection.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
	// A stale checkpoint must actually free enough space, especially for overflow recovery.
	if (after >= window - reserveTokens - 1024 || tokensBefore - after < Math.max(1024, window * 0.01)) return undefined;
	return {
		summary: checkpoint.summary, firstKeptEntryId: checkpoint.firstKeptEntryId,
		tokensBefore, estimatedTokensAfter: after,
		details: { type: CHECKPOINT_TYPE, version: 1, provider: checkpoint.provider, model: checkpoint.model },
	};
}
