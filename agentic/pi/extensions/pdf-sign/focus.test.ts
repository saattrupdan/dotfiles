import assert from "node:assert/strict";
import { test } from "node:test";
import { captureReturnTarget, returnToPi } from "./focus.ts";

test("captures the original iTerm session rather than whichever app happens to be frontmost later", () => {
	const env = { TERM_PROGRAM: "iTerm.app", ITERM_SESSION_ID: "w1t2p0:origin-session" };
	const target = captureReturnTarget(env);
	env.ITERM_SESSION_ID = "w2:another-session";
	assert.deepEqual(target, { kind: "iterm", sessionID: "origin-session" });
	assert.deepEqual(captureReturnTarget({ TERM_PROGRAM: "Apple_Terminal" }), { kind: "application", bundleID: "com.apple.Terminal" });
	assert.equal(captureReturnTarget({}), undefined);
});

test("selects the exact iTerm tab/pane/window with literal arguments and no screen inspection", async () => {
	const id = 'origin"; not a script';
	const calls: Array<{ file: string; args: string[] }> = [];
	await returnToPi({ kind: "iterm", sessionID: id }, async (file, args) => {
		calls.push({ file, args });
		return "restored\n";
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].file, "/usr/bin/osascript");
	assert.equal(calls[0].args[2], id);
	const script = calls[0].args[1];
	assert.match(script, /select aTab[\s\S]*select aSession[\s\S]*select aWindow/);
	assert.doesNotMatch(script, /System Events|contents|origin"/);
});

test("a closed origin session does not silently select a different window", async () => {
	let calls = 0;
	await assert.rejects(returnToPi({ kind: "iterm", sessionID: "gone" }, async () => { calls++; return "missing"; }), /no longer available/);
	assert.equal(calls, 1);
});

test("other terminal apps use LaunchServices and unknown origins do nothing", async () => {
	const calls: string[][] = [];
	const run = async (file: string, args: string[]) => { calls.push([file, ...args]); return ""; };
	await returnToPi({ kind: "application", bundleID: "com.apple.Terminal" }, run);
	await returnToPi(undefined, run);
	assert.deepEqual(calls, [["/usr/bin/open", "-b", "com.apple.Terminal"]]);
});
