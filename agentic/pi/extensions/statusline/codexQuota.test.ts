import { expect, test } from "bun:test";

import { bucketRemainingPercent, parseClaudeUsageOutput, parseCodexQuotaHeaders } from "./codexQuota.ts";

test("parses primary/secondary rate-limit headers into session/weekly buckets", () => {
	const quota = parseCodexQuotaHeaders({
		"x-codex-plan-type": "plus",
		"x-codex-primary-used-percent": "100",
		"x-codex-primary-window-minutes": "300",
		"x-codex-primary-reset-at": "1783293237",
		"x-codex-secondary-used-percent": "33",
		"x-codex-secondary-window-minutes": "10080",
		"x-codex-secondary-reset-at": "1783862018",
	});

	expect(quota.session?.used).toBe(100);
	expect(quota.session?.remaining).toBe(0);
	expect(quota.session?.window).toBe("5h");
	expect(quota.session?.resetAt).toBe(1783293237000);

	expect(quota.weekly?.used).toBe(33);
	expect(quota.weekly?.remaining).toBe(67);
	expect(quota.weekly?.window).toBe("7d");

	expect(bucketRemainingPercent(quota.session ?? {})).toBe(0);
	expect(bucketRemainingPercent(quota.weekly ?? {})).toBe(67);
});

test("is case-insensitive and accepts a Headers instance", () => {
	const headers = new Headers();
	headers.set("X-Codex-Primary-Used-Percent", "38");
	headers.set("X-Codex-Primary-Window-Minutes", "300");

	const quota = parseCodexQuotaHeaders(headers);
	expect(quota.session?.used).toBe(38);
	expect(quota.session?.remaining).toBe(62);
});

test("derives resetAt from reset-after-seconds when reset-at is absent", () => {
	const before = Date.now();
	const quota = parseCodexQuotaHeaders({
		"x-codex-primary-used-percent": "10",
		"x-codex-primary-window-minutes": "300",
		"x-codex-primary-reset-after-seconds": "600",
	});
	const after = Date.now();

	expect(quota.session?.resetAt).toBeGreaterThanOrEqual(before + 600_000);
	expect(quota.session?.resetAt).toBeLessThanOrEqual(after + 600_000);
});

test("only surfaces credits when meaningful", () => {
	const emptyCredits = parseCodexQuotaHeaders({
		"x-codex-primary-used-percent": "5",
		"x-codex-credits-balance": "0",
		"x-codex-credits-has-credits": "False",
		"x-codex-credits-unlimited": "False",
	});
	expect(emptyCredits.credits).toBeUndefined();

	const withBalance = parseCodexQuotaHeaders({
		"x-codex-credits-balance": "42",
		"x-codex-credits-has-credits": "True",
		"x-codex-credits-unlimited": "False",
	});
	expect(withBalance.credits).toEqual({ balance: 42, unlimited: false });

	const unlimited = parseCodexQuotaHeaders({
		"x-codex-credits-balance": "0",
		"x-codex-credits-unlimited": "True",
	});
	expect(unlimited.credits).toEqual({ balance: 0, unlimited: true });
});

test("returns empty quota when no rate-limit headers are present", () => {
	const quota = parseCodexQuotaHeaders({ "content-type": "text/event-stream" });
	expect(quota.session).toBeUndefined();
	expect(quota.weekly).toBeUndefined();
	expect(quota.credits).toBeUndefined();
});

test("parses Claude Code /usage output into session and weekly buckets", () => {
	const quota = parseClaudeUsageOutput(`You are currently using your subscription to power your Claude Code usage

Current session: 61% used · resets Jul 8 at 9:39pm (Europe/Copenhagen)
Current week (all models): 46% used · resets Jul 11 at 12:59am (Europe/Copenhagen)
Current week (Fable): 2% used · resets Jul 11 at 12:59am (Europe/Copenhagen)
`);

	expect(quota.session?.used).toBe(61);
	expect(quota.session?.remaining).toBe(39);
	expect(quota.session?.window).toBe("5h");
	expect(Number.isFinite(quota.session?.resetAt)).toBe(true);

	expect(quota.weekly?.used).toBe(46);
	expect(quota.weekly?.remaining).toBe(54);
	expect(quota.weekly?.window).toBe("7d");
	expect(Number.isFinite(quota.weekly?.resetAt)).toBe(true);
});
