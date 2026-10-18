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
		assert.deepEqual(tools, ["search_concepts", "update_concept", "remove_concept", "lint_concepts"]);
	} finally {
		if (previous === undefined) delete process.env.PI_MEMORY_RECALL_ONLY;
		else process.env.PI_MEMORY_RECALL_ONLY = previous;
		if (previousCleaning === undefined) delete process.env.PI_MEMORY_CLEANING_ONLY;
		else process.env.PI_MEMORY_CLEANING_ONLY = previousCleaning;
	}
});

test("scheduled cleaner cannot remove linked concepts or exceed five writes", async () => {
	const previous = process.env.PI_MEMORY_CLEANING_ONLY;
	const previousRecall = process.env.PI_MEMORY_RECALL_ONLY;
	try {
		process.env.PI_MEMORY_CLEANING_ONLY = "1";
		delete process.env.PI_MEMORY_RECALL_ONLY;
		let writes = 0;
		const store = {
			lint: () => [{ kind: "orphan", path: "/orphan.md" }],
			update: async () => { writes++; return { paths: ["/orphan.md"], missingEmbeddings: [] }; },
			remove: async () => { writes++; return { removed: ["/orphan.md"], archive: "/requests/removed/1" }; },
		};
		type Tool = { name: string; execute: (id: string, params: Record<string, string>) => Promise<unknown> };
		const tools = new Map<string, Tool>();
		register({ registerTool: (tool: Tool) => tools.set(tool.name, tool) } as never, () => store as never);
		const remove = tools.get("remove_concept")!;
		await assert.rejects(remove.execute("test", { path: "/linked.md" }), /no inbound links/);
		for (let n = 0; n < 4; n++) await tools.get("update_concept")!.execute("test", { path: "/orphan.md", body: "fact" });
		await remove.execute("test", { path: "/orphan.md" });
		assert.equal(writes, 5);
		await assert.rejects(remove.execute("test", { path: "/orphan.md" }), /limited to five/);
		assert.equal(writes, 5);
	} finally {
		if (previous === undefined) delete process.env.PI_MEMORY_CLEANING_ONLY;
		else process.env.PI_MEMORY_CLEANING_ONLY = previous;
		if (previousRecall === undefined) delete process.env.PI_MEMORY_RECALL_ONLY;
		else process.env.PI_MEMORY_RECALL_ONLY = previousRecall;
	}
});
