import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import register from "./index.ts";

test("librarian registers six tools, while recall handoff registers only search and read", () => {
	const previous = process.env.PI_MEMORY_RECALL_ONLY;
	const previousCleaning = process.env.PI_MEMORY_CLEANING_ONLY;
	try {
		delete process.env.PI_MEMORY_CLEANING_ONLY;
		const tools: string[] = [];
		const pi = { registerTool: (definition: { name: string }) => tools.push(definition.name) };
		delete process.env.PI_MEMORY_RECALL_ONLY;
		register(pi as never);
		assert.deepEqual(tools, ["search_concepts", "read_concept", "create_concept", "update_concept", "remove_concept", "lint_concepts"]);
		tools.length = 0;
		process.env.PI_MEMORY_RECALL_ONLY = "1";
		register(pi as never);
		assert.deepEqual(tools, ["search_concepts", "read_concept"]);
		tools.length = 0;
		delete process.env.PI_MEMORY_RECALL_ONLY;
		process.env.PI_MEMORY_CLEANING_ONLY = "1";
		register(pi as never);
		assert.deepEqual(tools, ["search_concepts", "read_concept", "update_concept", "remove_concept", "lint_concepts"]);
	} finally {
		if (previous === undefined) delete process.env.PI_MEMORY_RECALL_ONLY;
		else process.env.PI_MEMORY_RECALL_ONLY = previous;
		if (previousCleaning === undefined) delete process.env.PI_MEMORY_CLEANING_ONLY;
		else process.env.PI_MEMORY_CLEANING_ONLY = previousCleaning;
	}
});

test("read_concept fetches one exact path without a query", async () => {
	const calls: unknown[] = [];
	const concept = { path: "/known.md", frontmatter: { type: "Note" }, body: "A fact." };
	const store = { search: async (options: unknown) => {
		calls.push(options);
		if ((options as { path: string }).path !== "/known.md") throw new Error("Concept not found");
		return concept;
	} };
	type Tool = { name: string; execute: (id: string, params: { path: string }) => Promise<{ details: unknown }> };
	const tools = new Map<string, Tool>();
	register({ registerTool: (tool: Tool) => tools.set(tool.name, tool) } as never, () => store as never);
	assert.deepEqual((await tools.get("read_concept")!.execute("test", { path: "/known.md" })).details, concept);
	assert.deepEqual(calls, [{ path: "/known.md" }]);
	await assert.rejects(tools.get("read_concept")!.execute("test", { path: "/missing.md" }), /Concept not found/);
});

test("lint fingerprints only the bundle state it actually inspected", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lint-stamp-test-"));
	try {
		const concept = path.join(root, "fact.md");
		fs.writeFileSync(concept, "before");
		let changeDuringLint = false;
		const store = { root, lint: () => {
			if (changeDuringLint) fs.writeFileSync(concept, "after!");
			return [];
		} };
		type Tool = { name: string; execute: (id: string, params: Record<string, string>) => Promise<{ details: unknown }> };
		const tools = new Map<string, Tool>();
		register({ registerTool: (tool: Tool) => tools.set(tool.name, tool) } as never, () => store as never);
		const lint = tools.get("lint_concepts")!;
		const stable = await lint.execute("test", {});
		assert.equal(typeof (stable.details as { fingerprint: unknown }).fingerprint, "string");
		changeDuringLint = true;
		const changed = await lint.execute("test", {});
		assert.equal((changed.details as { fingerprint: unknown }).fingerprint, null);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("scheduled cleaner cannot remove linked concepts but permits all necessary writes", async () => {
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
		for (let n = 0; n < 6; n++) await tools.get("update_concept")!.execute("test", { path: "/orphan.md", body: "fact" });
		await remove.execute("test", { path: "/orphan.md" });
		assert.equal(writes, 7);
	} finally {
		if (previous === undefined) delete process.env.PI_MEMORY_CLEANING_ONLY;
		else process.env.PI_MEMORY_CLEANING_ONLY = previous;
		if (previousRecall === undefined) delete process.env.PI_MEMORY_RECALL_ONLY;
		else process.env.PI_MEMORY_RECALL_ONLY = previousRecall;
	}
});
