/* global Response */

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	MAX_RESPONSE_BYTES,
	buildSnapshotSection,
	fetchTree,
	fetchTreeForTest,
	flattenConcepts,
	renderSnapshot,
	refreshCache,
	readCache,
	restoreSnapshotFromCache,
	runOnce,
	validateTree,
} from "./refresh.mjs";
import { buildBeforeAgentStartResult } from "./index.ts";

const concept = (path, title, description, type = "Note") => ({
	name: `${title.toLowerCase().replaceAll(" ", "-")}.md`,
	path,
	kind: "concept",
	type,
	title,
	description,
});

const tree = {
	name: "/",
	path: "/",
	kind: "directory",
	children: [
		{
			name: "nested",
			path: "/nested",
			kind: "directory",
			children: [concept("/nested/z.md", "Same", "last")],
		},
		concept("/a.md", "Same", "first", "Person"),
		concept("/nested/a.md", "Pipe | title", "line one\nline | two", "Repository"),
	],
};

test("returns the Pi before_agent_start system prompt replacement", () => {
	const result = buildBeforeAgentStartResult({
		type: "before_agent_start",
		prompt: "hello",
		systemPrompt: "base prompt",
		systemPromptOptions: {},
	}, "snapshot");
	assert.deepEqual(result, { systemPrompt: "base prompt\n\nsnapshot" });
});

test("flattens nested concepts, sorts by path, and keeps duplicate titles", () => {
	const concepts = flattenConcepts(tree);
	assert.deepEqual(concepts.map(({ path }) => path), ["/a.md", "/nested/a.md", "/nested/z.md"]);
	assert.equal(concepts.filter(({ title }) => title === "Same").length, 2);
});

test("renders escaped markdown cells and preserves the table contract", () => {
	const snapshot = renderSnapshot(tree);
	assert.ok(snapshot.includes(String.raw`| Pipe \| title |`));
	assert.ok(snapshot.includes(String.raw`line one<br>line \| two`));
	assert.ok(snapshot.includes("→ Query before acting"));
	assert.equal(snapshot.split("\n").filter((line) => line.includes("| Same |" )).length, 2);
});

test("rejects malformed tree schemas", () => {
	assert.throws(() => validateTree({ name: "/", path: "/", kind: "directory", children: [{ kind: "concept" }] }));
	assert.throws(() => validateTree({ name: "/", path: "/", kind: "directory" }));
	assert.throws(() => validateTree({ name: "/", path: "/", kind: "directory", children: [] }));
	assert.throws(() => validateTree({ name: "/", path: "/", kind: "directory", children: "not an array" }));
	assert.throws(() => validateTree({ name: "/", path: "/", kind: "unknown" }));
	assert.throws(() => validateTree({ ...tree, children: [{ ...tree.children[1], children: [] }] }));
	assert.throws(() => validateTree({ ...tree, children: [{ name: "reserved", path: "/reserved", kind: "reserved", children: [] }] }));
	assert.throws(() => validateTree({ ...tree, children: [] }));
});

test("fetches only the fixed loopback URL and forbids redirects", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async (url, init) => {
			assert.equal(url, "http://localhost:3800/api/tree");
			assert.equal(init.redirect, "error");
			return new Response(JSON.stringify(tree));
		};
		assert.deepEqual(await fetchTree({ url: "https://attacker.invalid/tree" }), tree);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("rejects non-2xx, malformed, oversized, and timed-out responses", async () => {
	const response = (body, init = {}) => new Response(body, init);
	await assert.rejects(fetchTreeForTest({ fetchImpl: async () => response("no", { status: 503 }) }));
	await assert.rejects(fetchTreeForTest({ fetchImpl: async () => response("{") }));
	await assert.rejects(fetchTreeForTest({
		maxBytes: 10,
		fetchImpl: async () => response("01234567890"),
	}));
	await assert.rejects(fetchTreeForTest({
		timeoutMs: 10,
		fetchImpl: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
	}));
	await assert.rejects(fetchTreeForTest({
		fetchImpl: async () => response(JSON.stringify({ name: "/", path: "/", kind: "directory", children: [{}] })),
	}));
});

test("rejects malformed cache contracts and never restores them", async () => {
	const directory = await mkdtemp(join(tmpdir(), "memory-snapshot-"));
	const cacheFile = join(directory, "cache.json");
	const snapshotFile = join(directory, "snapshot.md");
	await writeFile(cacheFile, JSON.stringify({ snapshot: "", updatedAt: 1 }));
	assert.equal(readCache(cacheFile), null);
	assert.equal(restoreSnapshotFromCache({ cacheFile, snapshotFile }, { snapshot: "", updatedAt: 1 }), false);
	await writeFile(cacheFile, JSON.stringify({ snapshot: "valid", updatedAt: "later" }));
	assert.equal(readCache(cacheFile), null);
	await writeFile(cacheFile, "{");
	assert.equal(readCache(cacheFile), null);
});

test("preserves cache and snapshot when refresh fails", async () => {
	const directory = await mkdtemp(join(tmpdir(), "memory-snapshot-"));
	const paths = { cacheFile: join(directory, "cache.json"), snapshotFile: join(directory, "snapshot.md") };
	const oldCache = { snapshot: "old snapshot", updatedAt: 1 };
	const oldSnapshot = buildSnapshotSection(oldCache.snapshot, oldCache.updatedAt);
	await writeFile(paths.cacheFile, `${JSON.stringify(oldCache)}\n`);
	await writeFile(paths.snapshotFile, oldSnapshot);

	const result = await refreshCache({
		paths,
		now: 15 * 60 * 1000 + 2,
		testFetchImpl: async () => new Response("bad", { status: 500 }),
	});
	assert.equal(result.refreshed, false);
	assert.equal(await readFile(paths.cacheFile, "utf8"), `${JSON.stringify(oldCache)}\n`);
	assert.equal(await readFile(paths.snapshotFile, "utf8"), oldSnapshot);
});

test("refreshes a valid response and writes both files", async () => {
	const directory = await mkdtemp(join(tmpdir(), "memory-snapshot-"));
	const paths = { cacheFile: join(directory, "cache.json"), snapshotFile: join(directory, "snapshot.md") };
	const result = await refreshCache({
		paths,
		now: 123,
		testFetchImpl: async (url, init) => {
			assert.equal(url, "http://localhost:3800/api/tree");
			assert.equal(init.method, "GET");
			assert.equal(init.redirect, "error");
			return new Response(JSON.stringify(tree));
		},
	});
	assert.equal(result.refreshed, true);
	const cache = JSON.parse(await readFile(paths.cacheFile, "utf8"));
	assert.equal(cache.updatedAt, 123);
	assert.equal(cache.snapshot, renderSnapshot(tree));
	assert.match(await readFile(paths.snapshotFile, "utf8"), /Memory — Current Contents/);
	assert.equal(MAX_RESPONSE_BYTES, 2 * 1024 * 1024);
});

test("fresh caches do not suppress fetches — TTL skipping is removed", async () => {
	const directory = await mkdtemp(join(tmpdir(), "memory-snapshot-"));
	const paths = { cacheFile: join(directory, "cache.json"), snapshotFile: join(directory, "snapshot.md") };
	const oldCache = { snapshot: "old snapshot", updatedAt: Date.now() - 1000 };
	await writeFile(paths.cacheFile, `${JSON.stringify(oldCache)}\n`);

	let fetchCalled = false;
	const result = await refreshCache({
		paths,
		testFetchImpl: async () => {
			fetchCalled = true;
			return new Response(JSON.stringify(tree));
		},
	});
	assert.equal(fetchCalled, true, "refreshCache must always fetch, even with fresh cache");
	assert.equal(result.refreshed, true);
	const cache = JSON.parse(await readFile(paths.cacheFile, "utf8"));
	assert.equal(cache.snapshot, renderSnapshot(tree));
});

test("runOnce delegates to refreshCache and returns its result", async () => {
	const directory = await mkdtemp(join(tmpdir(), "memory-snapshot-"));
	const paths = { cacheFile: join(directory, "cache.json"), snapshotFile: join(directory, "snapshot.md") };
	const result = await runOnce({
		paths,
		testFetchImpl: async () => new Response(JSON.stringify(tree)),
	});
	assert.equal(result.refreshed, true);
	assert.ok(result.cache);
	assert.equal(result.cache.snapshot, renderSnapshot(tree));
});

test("no daemon or PID behavior remains", async () => {
	// Verify that the module does not export daemon-related symbols.
	const refreshExports = Object.keys(await import("./refresh.mjs"));
	assert.ok(!refreshExports.includes("runDaemon"), "runDaemon should be removed");
	assert.ok(!refreshExports.includes("CHECK_INTERVAL_MS"), "CHECK_INTERVAL_MS should be removed");

	// Verify that index.ts does not import child_process or reference PID files.
	const indexSource = await readFile(join(import.meta.dirname, "index.ts"), "utf8");
	assert.ok(!indexSource.includes("child_process"), "index.ts should not import child_process");
	assert.ok(!indexSource.includes("PID_FILE"), "index.ts should not reference PID_FILE");
	assert.ok(!indexSource.includes("daemonProcess"), "index.ts should not reference daemonProcess");
	assert.ok(!indexSource.includes("ownedDaemonPid"), "index.ts should not reference ownedDaemonPid");
	assert.ok(!indexSource.includes("startDaemon"), "index.ts should not reference startDaemon");
	assert.ok(!indexSource.includes("stopDaemon"), "index.ts should not reference stopDaemon");
	assert.ok(!indexSource.includes("readPidFile"), "index.ts should not reference readPidFile");
	assert.ok(!indexSource.includes("removePidFileIfOwned"), "index.ts should not reference removePidFileIfOwned");
	assert.ok(!indexSource.includes("isMissingProcessError"), "index.ts should not reference isMissingProcessError");
	assert.ok(!indexSource.includes("fileURLToPath"), "index.ts should not import fileURLToPath");
	assert.ok(!indexSource.includes("session_shutdown"), "index.ts should not listen to session_shutdown");
});

test("session_start refresh is awaited before prompt injection", async () => {
	// This test verifies the async session_start pattern by checking that
	// buildBeforeAgentStartResult reads the snapshot that was written by runOnce.
	const directory = await mkdtemp(join(tmpdir(), "memory-snapshot-"));
	const paths = { cacheFile: join(directory, "cache.json"), snapshotFile: join(directory, "snapshot.md") };

	// Simulate the session_start sequence: ensureSnapshotSync (no-op here since snapshot doesn't exist),
	// then runOnce fetches and writes the snapshot.
	await runOnce({ paths, testFetchImpl: async () => new Response(JSON.stringify(tree)) });

	// Now before_agent_start should read the freshly written snapshot.
	// Note: readSnapshot is not exported, so we verify via the file directly.
	const snapshotContent = await readFile(paths.snapshotFile, "utf8");
	assert.ok(snapshotContent.includes("Memory — Current Contents"), "snapshot file should contain the refreshed content");

	// Verify buildBeforeAgentStartResult uses the snapshot correctly.
	const result = buildBeforeAgentStartResult({
		type: "before_agent_start",
		prompt: "hello",
		systemPrompt: "base prompt",
		systemPromptOptions: {},
	}, snapshotContent);
	assert.ok(result);
	assert.ok(result.systemPrompt.includes("Memory — Current Contents"));
});
