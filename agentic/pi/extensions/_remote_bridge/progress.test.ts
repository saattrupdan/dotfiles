import test from "node:test";
import assert from "node:assert/strict";
import { initTheme, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { SubagentProgress } from "./progress.ts";
import type { ToolProgress } from "../_tool-display/block-types.ts";

initTheme("dark");
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
function partial(text: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text }],
		details: {
			agent: "builder",
			agentSource: "user",
			task: "Fix the tests",
			exitCode: 0,
			sessionLabel: "Builder #2",
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "nested", name: "bash", arguments: { command: "npm test" } },
					],
				},
				{ role: "assistant", content: [{ type: "text", text }] },
			],
			usage: {
				input: 5,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 1,
			},
		},
	};
}
const args = { agent: "builder", taskName: "Fix tests", task: "Fix the tests", agentScope: "user" };

test("native subagent progress coalesces, deduplicates and replays its bounded preview", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const sent: ToolProgress[] = [];
	const progress = new SubagentProgress((block) => sent.push(block));
	progress.update("parent", args, partial("First step"), theme);
	progress.update("parent", args, partial("Fixing the next test"), theme);
	assert.equal(sent.length, 0);
	t.mock.timers.tick(250);
	assert.equal(sent.length, 1);
	assert.match(sent[0]!.toolDisplay, /Builder #2/);
	assert.match(sent[0]!.toolDisplay, /npm test/);
	assert.match(sent[0]!.toolDisplay, /Fixing the next test/);
	assert.doesNotMatch(sent[0]!.toolDisplay, /First step/);
	assert(!sent[0]!.toolDisplay.includes(String.fromCharCode(27)));
	progress.update("parent", args, partial("Fixing the next test"), theme);
	t.mock.timers.tick(250);
	assert.equal(sent.length, 1);
	progress.replay();
	assert.equal(sent.length, 2);
	assert.deepEqual(sent[1], sent[0]);
	progress.update("parent", args, partial("Old preview must not arrive after completion"), theme);
	progress.end("parent");
	t.mock.timers.tick(250);
	progress.replay();
	assert.equal(sent.length, 2);
	progress.update("other", args, partial("Private"), theme);
	progress.clear();
	t.mock.timers.tick(250);
	progress.replay();
	assert.equal(sent.length, 2);
});

test("subagent previews keep original partial results untouched and cap transport text", () => {
	const sent: ToolProgress[] = [];
	const progress = new SubagentProgress((block) => sent.push(block));
	const result = partial("long content ".repeat(5000)),
		original = JSON.stringify(result);
	progress.update("parent", args, result, theme);
	progress.replay();
	assert.equal(sent.length, 1);
	assert(sent[0]!.toolDisplay.length <= 16384);
	assert.equal(JSON.stringify(result), original);
	assert.deepEqual(Object.keys(sent[0]!).sort(), [
		"toolCallId",
		"toolDisplay",
		"toolDisplayStyles",
	]);
	progress.clear();
});
