import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
	bucketRemainingPercent,
	findLatestCodexRateLimitsEvent,
	readCodexQuotaFromDirectory,
} from "./codexQuota.ts";

const tempDirs: string[] = [];

function makeSessionsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "codex-quota-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("selects the freshest rate limits event by event timestamp across files", () => {
	const dir = makeSessionsDir();
	const oldEventNewMtime = writeRollout(dir, "2026/01/01/rollout-old.jsonl", [
		rateLimitsLine("2026-01-01T00:00:00.000Z", 1, 16),
	], new Date("2026-01-03T00:00:00.000Z"));
	writeRollout(dir, "2026/01/02/rollout-new.jsonl", [
		rateLimitsLine("2026-01-02T00:00:00.000Z", 60, 20),
	], new Date("2026-01-01T00:00:00.000Z"));

	const latest = findLatestCodexRateLimitsEvent(dir);
	const quota = readCodexQuotaFromDirectory(dir);

	expect(latest?.path).not.toBe(oldEventNewMtime);
	expect(quota.session?.used).toBe(60);
	expect(quota.session?.remaining).toBe(40);
	expect(bucketRemainingPercent(quota.session ?? {})).toBe(40);
	expect(quota.weekly?.remaining).toBe(80);
});

test("falls back to rollout file mtime when event timestamp is absent", () => {
	const dir = makeSessionsDir();
	writeRollout(dir, "2026/01/01/rollout-old.jsonl", [
		rateLimitsLine(undefined, 10, 10),
	], new Date("2026-01-01T00:00:00.000Z"));
	const newerPath = writeRollout(dir, "2026/01/02/rollout-new.jsonl", [
		rateLimitsLine(undefined, 30, 40),
	], new Date("2026-01-02T00:00:00.000Z"));

	const latest = findLatestCodexRateLimitsEvent(dir);
	const quota = readCodexQuotaFromDirectory(dir);

	expect(latest?.path).toBe(newerPath);
	expect(quota.session?.remaining).toBe(70);
	expect(quota.weekly?.remaining).toBe(60);
});

function writeRollout(
	root: string,
	relativePath: string,
	lines: string[],
	mtime: Date,
): string {
	const path = join(root, relativePath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${lines.join("\n")}\n`, "utf-8");
	utimesSync(path, mtime, mtime);
	return path;
}

function rateLimitsLine(
	timestamp: string | undefined,
	primaryUsedPercent: number,
	secondaryUsedPercent: number,
): string {
	return JSON.stringify({
		type: "rate_limits",
		...(timestamp === undefined ? {} : { timestamp }),
		payload: {
			type: "rate_limits",
			rate_limits: {
				primary: {
					used_percent: primaryUsedPercent,
					window_minutes: 300,
					resets_at: 1767232800,
				},
				secondary: {
					used_percent: secondaryUsedPercent,
					window_minutes: 10080,
					resets_at: 1767837600,
				},
			},
		},
	});
}
