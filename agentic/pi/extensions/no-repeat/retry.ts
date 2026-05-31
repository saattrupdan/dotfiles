import * as crypto from "node:crypto";

const expectedAutoloadRetries = new Map<string, string>();

export function canonicalize(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(canonicalize);
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value as object).sort()) {
		out[key] = canonicalize((value as Record<string, unknown>)[key]);
	}
	return out;
}

export function canonicalInput(value: unknown): string | undefined {
	try {
		const json = JSON.stringify(canonicalize(value));
		if (!json || json === "{}" || json === "null") return undefined;
		return json;
	} catch {
		return String(value);
	}
}

export function toolCallFingerprint(toolName: string, input: unknown): string {
	const json = canonicalInput(input) ?? String(input);
	return `${toolName}\0${crypto.createHash("sha1").update(json).digest("hex")}`;
}

export function recordAutoloadRetry(sessionId: string, toolName: string, input: unknown): void {
	expectedAutoloadRetries.set(sessionId, toolCallFingerprint(toolName, input));
}

export function consumeAutoloadRetry(sessionId: string, toolName: string, input: unknown): boolean {
	const expected = expectedAutoloadRetries.get(sessionId);
	if (!expected) return false;

	expectedAutoloadRetries.delete(sessionId);
	return expected === toolCallFingerprint(toolName, input);
}

export function clearAutoloadRetry(sessionId: string): void {
	expectedAutoloadRetries.delete(sessionId);
}
