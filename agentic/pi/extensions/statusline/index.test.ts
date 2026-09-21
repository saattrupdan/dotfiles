import assert from "node:assert/strict";
import test from "node:test";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import { wrapStatusline } from "./index.ts";

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
