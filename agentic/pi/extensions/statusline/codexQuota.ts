import { readFileSync } from "fs";

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

const PI_AUTH_FILE = `${process.env.HOME}/.pi/agent/auth.json`;
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const PROBE_TIMEOUT_MS = 12_000;

// The Codex backend only reports live quota in the `x-codex-*` response headers
// of POST /codex/responses (never a cheap GET), and it returns them even on a
// 429. Pi issues its own codex requests over WebSocket, so it never writes
// ~/.codex rollout files and never surfaces those headers to extensions. To keep
// the bars fresh we make our own minimal request and read just the headers.

type HeaderGetter = { get(name: string): string | null };

function asHeaderGetter(headers: Headers | Record<string, string>): HeaderGetter {
	if (typeof (headers as Headers).get === "function") return headers as Headers;
	const record = headers as Record<string, string>;
	const lower: Record<string, string> = {};
	for (const key of Object.keys(record)) lower[key.toLowerCase()] = record[key];
	return { get: (name) => lower[name.toLowerCase()] ?? null };
}

/**
 * Parse the `x-codex-*` rate-limit headers from a /codex/responses response
 * into our CodexQuota structure.
 */
export function parseCodexQuotaHeaders(headers: Headers | Record<string, string>): CodexQuota {
	const h = asHeaderGetter(headers);
	const result: CodexQuota = {};

	const session = parseHeaderBucket(h, "primary");
	if (session) result.session = session;

	const weekly = parseHeaderBucket(h, "secondary");
	if (weekly) result.weekly = weekly;

	const balance = parseFiniteNumber(h.get("x-codex-credits-balance"));
	const unlimited = parseBoolean(h.get("x-codex-credits-unlimited"));
	const hasCredits = parseBoolean(h.get("x-codex-credits-has-credits"));
	// Only surface credits when meaningful — avoid a noisy "credits 0" chip.
	if (unlimited || hasCredits || (balance !== undefined && balance > 0)) {
		result.credits = { balance: balance ?? 0, unlimited };
	}

	return result;
}

function parseHeaderBucket(h: HeaderGetter, prefix: "primary" | "secondary"): QuotaBucket | undefined {
	const usedPercent = parseFiniteNumber(h.get(`x-codex-${prefix}-used-percent`));
	const windowMinutes = parseFiniteNumber(h.get(`x-codex-${prefix}-window-minutes`));
	const resetAtSeconds = parseFiniteNumber(h.get(`x-codex-${prefix}-reset-at`));
	const resetAfterSeconds = parseFiniteNumber(h.get(`x-codex-${prefix}-reset-after-seconds`));

	if (usedPercent === undefined && windowMinutes === undefined && resetAtSeconds === undefined) {
		return undefined;
	}

	const resetAt = resetAtSeconds !== undefined
		? Math.floor(resetAtSeconds * 1000)
		: resetAfterSeconds !== undefined
			? Date.now() + resetAfterSeconds * 1000
			: undefined;

	return {
		used: usedPercent,
		remaining: usedPercent === undefined ? undefined : 100 - clampPercent(usedPercent),
		// Historical cache entries use `percent`; keep it as usage, not remaining.
		percent: usedPercent,
		resetAt,
		window: classifyWindow(windowMinutes),
	};
}

type CodexAuth = { access: string; accountId: string };

function loadCodexAuth(): CodexAuth | undefined {
	try {
		const raw = JSON.parse(readFileSync(PI_AUTH_FILE, "utf-8")) as unknown;
		if (!isRecord(raw)) return undefined;
		const codex = raw["openai-codex"];
		if (!isRecord(codex)) return undefined;

		const access = typeof codex.access === "string" ? codex.access : undefined;
		if (!access) return undefined;

		// If the token is expired (or about to be), skip — pi refreshes it on its
		// next real request, and our next probe will pick up the fresh one.
		const expires = typeof codex.expires === "number" ? codex.expires : undefined;
		if (expires !== undefined && expires <= Date.now() + 60_000) return undefined;

		const accountId = typeof codex.accountId === "string"
			? codex.accountId
			: extractAccountIdFromJwt(access);
		if (!accountId) return undefined;

		return { access, accountId };
	} catch {
		return undefined;
	}
}

function extractAccountIdFromJwt(token: string): string | undefined {
	try {
		const payload = token.split(".")[1];
		if (!payload) return undefined;
		const json = JSON.parse(Buffer.from(payload, "base64").toString("utf-8")) as unknown;
		if (!isRecord(json)) return undefined;
		const auth = json["https://api.openai.com/auth"];
		if (!isRecord(auth)) return undefined;
		return typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Fetch live Codex quota by making a minimal /codex/responses request and
 * reading the `x-codex-*` rate-limit headers. The request stream is aborted as
 * soon as the headers arrive, so it consumes negligible quota (and a 429 while
 * rate limited consumes none). Returns undefined on any failure.
 */
export async function fetchCodexQuotaFromApi(model = "gpt-5.5"): Promise<CodexQuota | undefined> {
	const auth = loadCodexAuth();
	if (!auth) return undefined;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	try {
		const response = await fetch(CODEX_RESPONSES_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${auth.access}`,
				"chatgpt-account-id": auth.accountId,
				originator: "pi",
				"OpenAI-Beta": "responses=experimental",
				accept: "text/event-stream",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model,
				store: false,
				stream: true,
				instructions: "You are a helpful assistant.",
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
				text: { verbosity: "low" },
				tool_choice: "auto",
				parallel_tool_calls: true,
			}),
			signal: controller.signal,
		});

		const quota = parseCodexQuotaHeaders(response.headers);
		// We only need the headers; abort the body so the model doesn't generate.
		controller.abort();

		return quota.session || quota.weekly || quota.credits ? quota : undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

function parseFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number.parseFloat(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function parseBoolean(value: string | null): boolean {
	return value !== null && /^true$/i.test(value.trim());
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
