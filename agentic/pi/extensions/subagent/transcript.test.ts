import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { TranscriptArchive, activityItems, type ToolOutput } from "./transcript.ts";
import { compactResult } from "./compact-result.ts";

const assistant = (content: unknown[]): Message => ({ role: "assistant", content }) as Message;
const text = (value: string) => assistant([{ type: "text", text: value }]);
const call = (id: string, args = { command: "echo hej" }) => assistant([{ type: "toolCall", id, name: "bash", arguments: args }]);
const result = (id: string, output: string): Message => ({ role: "toolResult", toolCallId: id, toolName: "bash",
	content: [{ type: "text", text: output }], details: { fullOutputPath: "/tmp/output" }, isError: false,
	durationMs: 42, timestamp: 0 }) as Message;

function archive(t: TestContext) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-transcript-test-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return { root, store: new TranscriptArchive(root) };
}

test("collapsed history counts five activity entries, not lines or assistant responses", (t) => {
	const { store } = archive(t), writer = store.create();
	writer.append(text("discarded"));
	writer.append(assistant([{ type: "text", text: "   " }, { type: "text", text: "one\ntwo\nthree\nfour\nfive\nsix" },
		{ type: "toolCall", id: "a", name: "bash", arguments: { command: "a" } },
		{ type: "toolCall", id: "b", name: "bash", arguments: { command: "b" } }]));
	writer.append(result("a", "å æ ø"));
	writer.append(result("b", "second output"));
	writer.append(text("fourth"));
	writer.append(text("fifth"));
	const items = store.read(writer.id, false);
	assert.equal(items.length, 5);
	assert.equal(items[0].type, "text");
	assert.match(JSON.stringify(items), /one\\ntwo\\nthree\\nfour\\nfive\\nsix/);
	assert.doesNotMatch(JSON.stringify(items), /discarded/);
	assert.match(JSON.stringify(items), /å æ ø/);
	assert.equal(items[1].type === "toolCall" && items[1].result?.durationMs, 42);
	assert.equal(items[1].type === "toolCall" && items[1].isPartial, false);
	writer.finish();
});

test("partial output and streamed arguments evolve in place without consuming entries", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { store } = archive(t), writer = store.create();
	writer.append(text("earlier"));
	writer.append(call("running"));
	writer.partial("running", { content: [{ type: "text", text: "partial" }], details: undefined, isError: false });
	let items = store.read(writer.id, false);
	assert.equal(items.length, 2);
	assert.equal(items[1].type === "toolCall" && items[1].isPartial, true);
	assert.match(JSON.stringify(items), /partial/);
	writer.append(result("running", "final"));
	items = store.read(writer.id, false);
	assert.equal(items.length, 2);
	assert.doesNotMatch(JSON.stringify(items), /partial"/);
	writer.stream(assistant(Array.from({ length: 6 }, (_, n) => ({ type: "text", text: `stream-${n}` }))));
	t.mock.timers.tick(50);
	assert.equal(store.read(writer.id, false).length, 5);
	assert.doesNotMatch(JSON.stringify(store.read(writer.id, false)), /earlier|stream-0/);
	writer.append(text("completed stream"));
	assert.doesNotMatch(JSON.stringify(store.read(writer.id, true)), /stream-5/);
	writer.finish();
});

test("expanded and resumed history retain old messages, full arguments, results and metadata", (t) => {
	const { root, store } = archive(t), writer = store.create();
	const command = "echo æøå ".repeat(4000), output = "payload æøå\n".repeat(9000);
	writer.append(call("first", { command }));
	writer.append(result("first", output));
	for (let n = 0; n < 250; n++) writer.append(text(`message-${n}`));
	writer.finish();
	const resumed = new TranscriptArchive(root).read(writer.id, true);
	assert.equal(resumed.length, 251);
	assert.equal(resumed[0].type === "toolCall" && resumed[0].args.command, command);
	assert.equal(resumed[0].type === "toolCall" && resumed[0].result?.content[0].type === "text" && resumed[0].result.content[0].text, output);
	assert.equal(store.read(writer.id, false).length, 5);
	const compact = compactResult({ messages: [call("first", { command }), result("first", output)], transcriptId: writer.id });
	assert.equal(compact.transcriptId, writer.id);
	assert.ok(JSON.stringify(compact).length < 3000);
	assert.equal(fs.statSync(path.join(root, `${writer.id}.jsonl`)).mode & 0o777, 0o600);
	assert.equal(fs.existsSync(path.join(root, `${writer.id}.jsonl.live`)), false);
});

test("archive ids cannot escape the transcript directory; legacy interpretation ignores thinking", (t) => {
	const { store } = archive(t);
	assert.throws(() => store.read("../../auth.json", true), /Invalid subagent transcript id/);
	const partial: ToolOutput = { content: [], details: { progress: 1 }, isError: false };
	const items = activityItems([assistant([{ type: "thinking", thinking: "hidden" }, { type: "text", text: "  " }]), call("id")], { id: partial });
	assert.equal(items.length, 1);
	assert.equal(items[0].type === "toolCall" && items[0].result, partial);
});


test("interrupted runs preserve the last streamed narration and partial tool output on disk", (t) => {
	const { root, store } = archive(t), writer = store.create();
	writer.append(call("unfinished"));
	writer.partial("unfinished", { content: [{ type: "text", text: "last tool progress" }], details: undefined, isError: false });
	writer.stream(text("last narration"));
	writer.finish();
	const items = new TranscriptArchive(root).read(writer.id, true);
	assert.equal(items.length, 2);
	assert.match(JSON.stringify(items), /last tool progress/);
	assert.match(JSON.stringify(items), /last narration/);
});


test("private history is memory-only, shared across renderers/reloads, and explicitly released", (t) => {
	const { root, store } = archive(t);
	const writer = store.create({ persist: false });
	writer.append(call("private", { command: "private arguments" }));
	writer.append(result("private", "private output"));
	writer.finish();
	assert.deepEqual(fs.readdirSync(root), []);
	const reloaded = new TranscriptArchive(root);
	assert.match(JSON.stringify(reloaded.read(writer.id, true)), /private arguments/);
	assert.match(JSON.stringify(reloaded.read(writer.id, true)), /private output/);
	store.clearPrivate();
	assert.throws(() => reloaded.read(writer.id, true), /no longer available/);
	assert.deepEqual(fs.readdirSync(root), []);
});

test("finish flushes the latest update inside the debounce window without a late callback", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { root, store } = archive(t);
	let updates = 0;
	const writer = store.create({ onUpdate: () => { updates++; } });
	writer.stream(text("latest buffered narration"));
	t.mock.timers.tick(25);
	writer.stream(call("streaming", { command: "latest buffered arguments" }));
	writer.finish();
	const items = new TranscriptArchive(root).read(writer.id, true);
	assert.match(JSON.stringify(items), /latest buffered arguments/);
	assert.doesNotMatch(JSON.stringify(items), /latest buffered narration/);
	t.mock.timers.tick(100);
	assert.equal(updates, 0);
});
