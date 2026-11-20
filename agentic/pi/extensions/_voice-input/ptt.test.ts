import assert from "node:assert/strict";
import test from "node:test";

import { applyStreamEventToText, needsStreamFallback, PttEditor } from "./ptt.ts";

test("voice editor keeps Pi's default top-border activity indicator and normal typing", () => {
	const tui = { terminal: { rows: 40 }, requestRender() {} } as ConstructorParameters<typeof PttEditor>[0];
	const theme = { borderColor: (text: string) => text } as ConstructorParameters<typeof PttEditor>[1];
	const keys = { matches: () => false } as unknown as ConstructorParameters<typeof PttEditor>[2];
	const editor = new PttEditor(tui, theme, keys);
	editor.setWorkingStatusIndicator({
		renderInBorder: () => "Thinking...",
		renderSpinnerInBorder: () => "*",
	} as Parameters<PttEditor["setWorkingStatusIndicator"]>[0]);
	editor.handleInput("x");
	assert.equal(editor.getText(), "x");
	assert.match(editor.render(80)[0], /Thinking\.\.\./);
	assert.equal(editor.embedWorkingStatus, true);
	assert.equal(editor.wantsKeyRelease, true, "push-to-talk key handling stays enabled");
});

test("an empty but successfully received final does not trigger batch fallback", () => {
	assert.equal(needsStreamFallback({ finalReceived: true, failed: false }), false);
});

test("a missing or failed stream final triggers batch fallback", () => {
	assert.equal(needsStreamFallback({ finalReceived: false, failed: false }), true);
	assert.equal(needsStreamFallback({ finalReceived: true, failed: true }), true);
});

test("an authoritative empty final removes a stale inline partial", () => {
	const session = {
		pcmChunks: [],
		stdoutBuffer: "",
		partialText: "",
		finalText: "",
		finalReceived: false,
		failed: false,
		failureReason: "",
		prefixText: "",
		partialStart: 0,
		partialLen: 0,
	};
	const partial = applyStreamEventToText(session, { type: "partial", text: "stale words" }, "");
	assert.equal(partial?.text, " stale words");

	const final = applyStreamEventToText(session, { type: "final", text: "" }, partial?.text ?? "");
	assert.equal(final?.text, "");
	assert.equal(session.finalReceived, true);
	assert.equal(session.partialLen, 0);
});
