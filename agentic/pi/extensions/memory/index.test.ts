import assert from "node:assert/strict";
import { test } from "node:test";

import register from "./index.ts";

test("librarian registers five tools, while recall handoff registers only search", () => {
	const previous = process.env.PI_MEMORY_RECALL_ONLY;
	const previousCleaning = process.env.PI_MEMORY_CLEANING_ONLY;
	try {
		delete process.env.PI_MEMORY_CLEANING_ONLY;
		const tools: string[] = [];
		const pi = { registerTool: (definition: { name: string }) => tools.push(definition.name) };
		delete process.env.PI_MEMORY_RECALL_ONLY;
		register(pi as never);
		assert.deepEqual(tools, ["search_concepts", "create_concept", "update_concept", "remove_concept", "lint_concepts"]);
		tools.length = 0;
		process.env.PI_MEMORY_RECALL_ONLY = "1";
		register(pi as never);
		assert.deepEqual(tools, ["search_concepts"]);
		tools.length = 0;
		delete process.env.PI_MEMORY_RECALL_ONLY;
		process.env.PI_MEMORY_CLEANING_ONLY = "1";
		register(pi as never);
		assert.deepEqual(tools, ["search_concepts", "update_concept", "lint_concepts"]);
	} finally {
		if (previous === undefined) delete process.env.PI_MEMORY_RECALL_ONLY;
		else process.env.PI_MEMORY_RECALL_ONLY = previous;
		if (previousCleaning === undefined) delete process.env.PI_MEMORY_CLEANING_ONLY;
		else process.env.PI_MEMORY_CLEANING_ONLY = previousCleaning;
	}
});
