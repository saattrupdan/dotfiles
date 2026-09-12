import assert from "node:assert/strict";
import test from "node:test";

import { applyStreamEventToText, needsStreamFallback } from "./ptt.ts";

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
