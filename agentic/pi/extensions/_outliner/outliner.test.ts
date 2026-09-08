import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { outline } from "./outliner.ts";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "LovgivningSearchField.fixture.tsx");

test("outlines the LovgivningSearchField TSX parser regression fixture", () => {
	const source = fs.readFileSync(fixture, "utf8");
	const result = outline(fixture, source);
	const names = result.entries.map((entry) => entry.name);

	assert.ok(names.includes("setFetcher"));
	assert.ok(names.includes("openPopover"));
	assert.ok(result.entries.some((entry) => entry.kind === "function"));
});
