import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import statusline, { readCurrentBranch, wrapStatusline } from "./index.ts";

test("readCurrentBranch returns the active branch and hides detached/non-Git states", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-statusline-branch-"));
	try {
		assert.equal(await readCurrentBranch(cwd), undefined);
		execFileSync("git", ["init", "-q", cwd]);
		execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/feat/footer"], { cwd });
		assert.equal(await readCurrentBranch(cwd), "feat/footer");
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "initial"], { cwd });
		execFileSync("git", ["checkout", "-q", "--detach", "HEAD"], { cwd });
		assert.equal(await readCurrentBranch(cwd), undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("wrapStatusline preserves long footer content", () => {
	const text = "model | context 12k / 128k | session 25% | weekly 10%";
	const lines = wrapStatusline(text, 24);

	assert.ok(lines.length > 1);
	assert.ok(lines.every((line) => visibleWidth(line) <= 24));
	assert.ok(lines.every((line) => line.startsWith(" ")));
	assert.equal(lines.map((line) => stripTerminalSequences(line).trim()).join(" "), text);
	assert.ok(lines.every((line) => !line.includes("...")));
});

test("wrapStatusline preserves ANSI-styled text across lines", () => {
	const text = "\u001b[36mmodel-name\u001b[0m | \u001b[2mcontext details\u001b[0m";
	const lines = wrapStatusline(text, 16);

	assert.ok(lines.length > 1);
	assert.ok(lines.every((line) => visibleWidth(line) <= 16));
	assert.equal(
		lines.map((line) => stripTerminalSequences(line).trim()).join(" "),
		"model-name | context details",
	);
});

test("wrapStatusline handles widths that only fit the indent", () => {
	assert.deepEqual(wrapStatusline("footer", 1), [" "]);
	assert.deepEqual(wrapStatusline("footer", 0), [""]);
});

test("sandbox footer installs before messages and retains the box indicator on session swaps", () => {
	const previous = process.env.PI_SANDBOX;
	process.env.PI_SANDBOX = "1";
	try {
		const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		let installs = 0;
		const pi = { on: (name: string, callback: (event: unknown, ctx: ExtensionContext) => void) => hooks.set(name, callback) } as unknown as ExtensionAPI;
		const ctx = { hasUI: true, cwd: "/tmp", sessionManager: { getEntries: () => [] }, ui: { setFooter: () => { installs++; } } } as unknown as ExtensionContext;
		statusline(pi);
		hooks.get("session_start")!({}, ctx);
		hooks.get("session_start")!({}, ctx);
		assert.equal(installs, 2);
		const lines = wrapStatusline("model | context | 📦", 18);
	assert.match(lines.join(" "), /📦/);
	assert.doesNotMatch(lines.join(" "), /sandbox|offline/);
	} finally {
		if (previous === undefined) delete process.env.PI_SANDBOX;
		else process.env.PI_SANDBOX = previous;
	}
});
