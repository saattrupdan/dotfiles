import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import { DIMENSIONS, MODEL, createEmbedder, type Embed } from "./embedding.ts";
import { MemoryStore } from "./store.ts";

const vector: Embed = async (text, side) => {
	const result = Array<number>(DIMENSIONS).fill(0);
	result[text.toLowerCase().includes("invoice") ? 0 : 1] = side === "query" ? 0.8 : 1;
	result[2] = 0.2;
	return result;
};

function snapshotRows(root: string): Array<{ path: string; hash: string; model: string; vector: Buffer }> {
	const snapshot = Database(path.join(root, "embeddings.sqlite"), { readonly: true });
	try { return snapshot.prepare("SELECT path, hash, model, vector FROM embeddings").all() as Array<{
		path: string; hash: string; model: string; vector: Buffer;
	}>; }
	finally { snapshot.close(); }
}

function fixture(embed: Embed = vector) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-test-"));
	const root = path.join(dir, "memory");
	fs.mkdirSync(root);
	const logs: string[] = [];
	const make = (useEmbed: Embed = embed) => new MemoryStore({ root,
		embed: useEmbed, log: (message) => logs.push(message) });
	const store = make();
	return { dir, root, store, logs, make, cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("creates OKF concepts and generated catalogs; hybrid RRF and exact-path reads", async () => {
	const f = fixture();
	try {
		const created = await f.store.create({ path: "/billing/invoice.md", type: "Service", title: "Invoice API",
			body: "Invoice records are stored here.", tags: ["billing"] });
		assert.deepEqual(created, { paths: ["/billing/invoice.md"], missingEmbeddings: [] });
		await f.store.create({ path: "/billing/other.md", type: "Service", body: "A separate service." });
		const exact = await f.store.search({ path: "/billing/invoice.md" });
		assert.deepEqual(exact, { path: "/billing/invoice.md",
			frontmatter: { type: "Service", title: "Invoice API", tags: ["billing"] },
			body: "Invoice records are stored here." });
		const ranked = await f.store.search({ query: "invoice" });
		assert.ok("results" in ranked);
		assert.equal(ranked.results[0].path, "/billing/invoice.md");
		assert.deepEqual(ranked.results[0].matchedBy, ["bm25", "embedding"]);
		assert.equal(ranked.embeddingFallback, false);
		assert.match(fs.readFileSync(path.join(f.root, "index.md"), "utf8"), /okf_version: "0.1"/);
		assert.match(fs.readFileSync(path.join(f.root, "billing", "index.md"), "utf8"), /Invoice API/);
		assert.match(fs.readFileSync(path.join(f.root, "log.md"), "utf8"), /\* \*\*Creation\*\*: \/billing\/invoice\.md/);
		const snapshotPath = path.join(f.root, "embeddings.sqlite");
		assert.deepEqual(fs.readdirSync(f.root).filter((name) => name.startsWith("embeddings.sqlite")), ["embeddings.sqlite"]);
		assert.ok(!fs.existsSync(path.join(f.root, "search.sqlite")));
		assert.equal(f.store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'embeddings'").get(), undefined);
		assert.equal(fs.statSync(snapshotPath).mode & 0o777, 0o600);
		assert.ok(!fs.existsSync(path.join(f.dir, "index")));
		const snapshot = Database(snapshotPath, { readonly: true });
		assert.deepEqual((snapshot.prepare("SELECT path FROM embeddings ORDER BY path").all() as Array<{ path: string }>).map((r) => r.path),
			["/billing/invoice.md", "/billing/other.md"]);
		snapshot.close();
		assert.ok(!f.logs.some((line) => line.includes("ANN index failed")));
		const semantic = await f.store.search({ query: "statement" });
		assert.ok("results" in semantic);
		assert.equal(semantic.results[0].path, "/billing/other.md");
		assert.deepEqual(semantic.results[0].matchedBy, ["embedding"]);
	} finally { f.cleanup(); }
});

test("embedding failures preserve BM25, log errors, and are visible to lint", async () => {
	const unavailable: Embed = async () => { throw new Error("local server offline"); };
	const f = fixture(unavailable);
	try {
		const created = await f.store.create({ path: "/invoice.md", type: "Note", body: "Invoice recovery instructions." });
		assert.deepEqual(created.missingEmbeddings, ["/invoice.md"]);
		const results = await f.store.search({ query: "invoice" });
		assert.ok("results" in results);
		assert.equal(results.embeddingFallback, true);
		assert.equal(results.results[0].path, "/invoice.md");
		assert.deepEqual(results.results[0].matchedBy, ["bm25"]);
		assert.ok(f.logs.some((line) => line.includes("embedding failed")));
		assert.ok(f.logs.some((line) => line.includes("using BM25 only")));
		assert.ok(f.store.lint().some((issue) => issue.kind === "missing_embedding"));
		f.store.close();
		const recovered = f.make(vector);
		try {
			await recovered.update({ path: "/invoice.md", body: "Invoice recovery instructions, revised." });
			assert.equal(recovered.lint().some((issue) => issue.kind === "missing_embedding"), false);
		} finally { recovered.close(); }
	} finally { f.cleanup(); }
});

test("rebuilds missing vectors without rewriting restored concepts", async () => {
	const f = fixture(async () => { throw new Error("embedding offline"); });
	try {
		await f.store.create({ path: "/record.md", type: "Note", body: "An unchanged restored concept." });
		const original = fs.readFileSync(path.join(f.root, "record.md"), "utf8");
		const recovered = f.make(vector);
		try {
			assert.deepEqual(await recovered.repairEmbeddings(), { attempted: 1, missingEmbeddings: [], pruned: [] });
			assert.deepEqual(await recovered.repairEmbeddings(), { attempted: 0, missingEmbeddings: [], pruned: [] });
			assert.equal(fs.readFileSync(path.join(f.root, "record.md"), "utf8"), original);
			assert.equal(snapshotRows(f.root).length, 1);
		} finally { recovered.close(); }
	} finally { f.cleanup(); }
});

test("resolves relative and root links and finds orphans, duplicate paragraphs and drift", async () => {
	const f = fixture();
	try {
		await f.store.create({ path: "/apis/first.md", type: "API", body: "See [customer](../datasets/customer.md) " +
			"and [billing](/apis/billing.md) and [missing](../missing.md).\n\n" +
			"A sufficiently long repeated paragraph about company billing.\n\n" +
			"A sufficiently long repeated paragraph about company billing." });
		await f.store.create({ path: "/datasets/customer.md", type: "Dataset", body: "Customer records." });
		await f.store.create({ path: "/apis/billing.md", type: "API", body: "Billing API." });
		const issues = f.store.lint();
		assert.deepEqual(issues.filter((issue) => issue.kind === "broken_link").map((issue) => issue.detail), ["../missing.md"]);
		assert.ok(issues.some((issue) => issue.kind === "duplicate_text" && issue.path === "/apis/first.md"));
		assert.ok(issues.some((issue) => issue.kind === "orphan" && issue.path === "/apis/first.md"));
		assert.ok(!issues.some((issue) => issue.kind === "orphan" && issue.path === "/datasets/customer.md"));
		assert.ok(!issues.some((issue) => issue.kind === "orphan" && issue.path === "/apis/billing.md"));
		fs.appendFileSync(path.join(f.root, "apis", "billing.md"), "\nEdited outside the tool.");
		assert.ok(f.store.lint().some((issue) => issue.kind === "stale_embedding" && issue.path === "/apis/billing.md"));
	} finally { f.cleanup(); }
});

test("scheduled cleanup rejects bulk orphan deletion but permits archived exact duplicates", async () => {
	const f = fixture();
	try {
		for (let n = 0; n < 6; n++) {
			await f.store.create({ path: `/unique-${n}.md`, type: "Note", body: `Unique fact ${n}.` });
		}
		for (let n = 0; n < 6; n++) {
			await assert.rejects(f.store.remove(`/unique-${n}.md`, true), /unlinked exact duplicates/);
			assert.ok(fs.existsSync(path.join(f.root, `unique-${n}.md`)));
		}
		await f.store.create({ path: "/copy.md", type: "Note", body: "Unique fact 0." });
		const removed = await f.store.remove("/copy.md", true);
		assert.deepEqual(removed.removed, ["/copy.md"]);
		assert.ok(fs.existsSync(path.join(f.root, "unique-0.md")));
		assert.ok(fs.existsSync(path.join(f.root, removed.archive.slice(1), "manifest.json")));
	} finally { f.cleanup(); }
});

test("oversized concepts split without losing text; updates and removals clean parts and vectors", async () => {
	const f = fixture();
	try {
		const original = ("Detailed record with a unique section and content.\n\n".repeat(1500));
		const created = await f.store.create({ path: "/long.md", type: "Note", body: original });
		assert.ok(created.paths.length > 3);
		assert.deepEqual(created.missingEmbeddings, []);
		const bodies = await Promise.all(created.paths.slice(0, -1).map((p) => f.store.search({ path: p })));
		assert.equal(bodies.map((entry) => "body" in entry ? entry.body : "").join(""), original);
		for (const p of created.paths) {
			assert.ok(fs.statSync(path.join(f.root, p.slice(1))).size <= 24_000, p);
		}
		await assert.rejects(f.store.remove(created.paths[0]), /Remove the parent concept/);
		const originalParent = fs.readFileSync(path.join(f.root, "long.md"), "utf8");
		const updated = await f.store.update({ path: "/long.md", body: "Now short." });
		assert.deepEqual(updated.paths, ["/long.md"]);
		assert.ok(updated.archive?.startsWith("/requests/versions/"));
		const versionDir = path.join(f.root, updated.archive!.slice(1));
		const prior = JSON.parse(fs.readFileSync(path.join(versionDir, "manifest.json"), "utf8"));
		assert.deepEqual(prior.entries.map((entry: { path: string }) => entry.path), ["/long.md", ...created.paths.slice(0, -1)]);
		assert.equal(fs.readFileSync(path.join(versionDir, prior.entries[0].file), "utf8"), originalParent);
		assert.equal(f.store.lint().some((issue) => issue.kind === "orphan_embedding"), false);
		for (const p of created.paths.slice(0, -1)) assert.ok(!fs.existsSync(path.join(f.root, p.slice(1))));
		const rawBeforeRemoval = fs.readFileSync(path.join(f.root, "long.md"), "utf8");
		const removal = await f.store.remove("/long.md");
		assert.deepEqual(removal.removed, ["/long.md"]);
		const archive = path.join(f.root, removal.archive.slice(1));
		const manifest = JSON.parse(fs.readFileSync(path.join(archive, "manifest.json"), "utf8"));
		assert.deepEqual(manifest.entries.map((entry: { path: string }) => entry.path), ["/long.md"]);
		assert.equal(fs.readFileSync(path.join(archive, manifest.entries[0].file), "utf8"), rawBeforeRemoval);
		const snapshot = Database(path.join(f.root, "embeddings.sqlite"), { readonly: true });
		assert.equal(snapshot.prepare("SELECT count(*) AS n FROM embeddings").get().n, 0);
		snapshot.close();
		assert.equal(f.store.lint().some((issue) => issue.kind.includes("embedding")), false);
		assert.deepEqual(snapshotRows(f.root), []);
	} finally { f.cleanup(); }
});

test("rejects escaping paths and conflicting generated children, reports orphan vectors", async () => {
	const f = fixture();
	try {
		await assert.rejects(f.store.create({ path: "/../escape.md", type: "Note", body: "bad" }), /Invalid concept path/);
		await assert.rejects(f.store.create({ path: "/log.md", type: "Note", body: "bad" }), /Invalid concept path/);
		await assert.rejects(f.store.create({ path: "/requests/job.md", type: "Note", body: "bad" }), /Invalid concept path/);
		fs.mkdirSync(path.join(f.root, "requests"));
		fs.writeFileSync(path.join(f.root, "requests", "failed.json"), '{"text":"private queued memory"}');
		assert.equal(f.store.lint().some((issue) => issue.path.includes("requests")), false);
		await f.store.create({ path: "/already-part-001.md", type: "Note", body: "Existing." });
		assert.ok(!fs.readFileSync(path.join(f.root, "index.md"), "utf8").includes("requests"));
		await assert.rejects(f.store.create({ path: "/already.md", type: "Note", body: "large ".repeat(12_000) }),
			/Generated part path already exists/);
		fs.mkdirSync(path.join(f.root, "symlink-target"));
		fs.symlinkSync(path.join(f.root, "symlink-target"), path.join(f.root, "escape"));
		await assert.rejects(f.store.create({ path: "/escape/out.md", type: "Note", body: "bad" }), /Symlinks are not allowed/);
		fs.unlinkSync(path.join(f.root, "already-part-001.md"));
		assert.ok(f.store.lint().some((issue) => issue.kind === "orphan_embedding" && issue.path === "/already-part-001.md"));
		fs.writeFileSync(path.join(f.root, "already-part-001.md"), "invalid frontmatter");
		assert.deepEqual(await f.store.repairEmbeddings(), { attempted: 0, missingEmbeddings: [], pruned: [] });
		assert.equal(fs.readFileSync(path.join(f.root, "already-part-001.md"), "utf8"), "invalid frontmatter");
		fs.unlinkSync(path.join(f.root, "already-part-001.md"));
		assert.deepEqual(await f.store.repairEmbeddings(), {
			attempted: 0, missingEmbeddings: [], pruned: ["/already-part-001.md"],
		});
		assert.equal(f.store.lint().some((issue) => issue.kind === "orphan_embedding"), false);
	} finally { f.cleanup(); }
});

test("preserves curated indexes and rejects reserved-file symlinks before writing", async () => {
	const f = fixture();
	try {
		const curated = "# Hand-maintained index\n\nDo not overwrite this text.\n";
		fs.writeFileSync(path.join(f.root, "index.md"), curated);
		await f.store.create({ path: "/one.md", type: "Note", body: "A first entry." });
		assert.equal(fs.readFileSync(path.join(f.root, "index.md"), "utf8"), curated);
		const outside = path.join(f.dir, "outside.txt");
		fs.writeFileSync(outside, "private text stays outside the bundle");
		fs.unlinkSync(path.join(f.root, "log.md"));
		fs.symlinkSync(outside, path.join(f.root, "log.md"));
		await assert.rejects(f.store.create({ path: "/blocked.md", type: "Note", body: "No write." }), /symlink/);
		assert.ok(!fs.existsSync(path.join(f.root, "blocked.md")));
		assert.equal(fs.readFileSync(outside, "utf8"), "private text stays outside the bundle");
	} finally { f.cleanup(); }
});

test("a concurrent removal cannot leave a late orphan embedding", async () => {
	let unblock: ((value: number[]) => void) | undefined;
	let started: (() => void) | undefined;
	const pending = new Promise<void>((resolve) => { started = resolve; });
	const delayed: Embed = async () => {
		started?.();
		return new Promise<number[]>((resolve) => { unblock = resolve; });
	};
	const f = fixture(delayed);
	try {
		const creating = f.store.create({ path: "/race.md", type: "Note", body: "Racing writes." });
		await pending;
		await f.store.remove("/race.md");
		unblock?.(Array<number>(DIMENSIONS).fill(0.1));
		await creating;
		assert.deepEqual(snapshotRows(f.root), []);
	} finally { f.cleanup(); }
});

test("an embedding in flight cannot resurrect a concept removed by another process", async () => {
	let unblock: ((value: number[]) => void) | undefined;
	let started: (() => void) | undefined;
	const pending = new Promise<void>((resolve) => { started = resolve; });
	const f = fixture(async () => {
		started?.();
		return new Promise<number[]>((resolve) => { unblock = resolve; });
	});
	const other = f.make(vector);
	try {
		const creating = f.store.create({ path: "/race.md", type: "Note", body: "Racing writers." });
		await pending;
		await other.remove("/race.md");
		unblock?.(Array<number>(DIMENSIONS).fill(0.1));
		await creating;
		assert.deepEqual(snapshotRows(f.root), []);
	} finally { other.close(); f.cleanup(); }
});

test("independent writers preserve canonical vectors without storing a second disk copy", async () => {
	const f = fixture();
	const other = f.make();
	try {
		await f.store.create({ path: "/first.md", type: "Note", body: "First stored concept." });
		await other.create({ path: "/second.md", type: "Note", body: "Second stored concept." });
		await f.store.create({ path: "/third.md", type: "Note", body: "Third stored concept." });
		assert.deepEqual(snapshotRows(f.root).map((row) => row.path).sort(),
			["/first.md", "/second.md", "/third.md"]);
		assert.equal(f.store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'embeddings'").get(), undefined);
	} finally { other.close(); f.cleanup(); }
});

test("old search caches are removed while canonical embeddings survive", async () => {
	const f = fixture();
	try {
		await f.store.create({ path: "/kept.md", type: "Note", body: "Kept concept." });
		const cache = Database(path.join(f.root, "search.sqlite"));
		cache.exec("CREATE TABLE embeddings (path TEXT, vector BLOB)");
		cache.prepare("INSERT INTO embeddings VALUES (?, ?)").run("/kept.md", snapshotRows(f.root)[0].vector);
		cache.close();
		f.store.close();
		const reopened = f.make();
		try {
			assert.ok(!fs.existsSync(path.join(f.root, "search.sqlite")));
			assert.equal(snapshotRows(f.root).length, 1);
			const results = await reopened.search({ query: "kept" });
			assert.ok("results" in results && results.results[0].matchedBy.includes("embedding"));
		} finally { reopened.close(); }
	} finally { f.cleanup(); }
});

test("imports legacy JSON embeddings into the atomic SQLite snapshot", async () => {
	const f = fixture();
	try {
		await f.store.create({ path: "/apis/billing.md", type: "API", body: "Billing search." });
		const row = snapshotRows(f.root)[0];
		fs.mkdirSync(path.join(f.root, ".embeddings"));
		const oldName = createHash("sha256").update(row.path).digest("hex") + ".json";
		fs.writeFileSync(path.join(f.root, ".embeddings", oldName), JSON.stringify({ path: row.path,
			hash: row.hash, model: row.model,
			vector: Array.from({ length: DIMENSIONS }, (_, i) => row.vector.readFloatLE(i * 4)) }));
		fs.unlinkSync(path.join(f.root, "embeddings.sqlite"));
		f.store.close();
		const moved = f.make();
		try {
			assert.ok(!moved.lint().some((issue) => issue.kind.includes("embedding")));
			assert.ok(fs.existsSync(path.join(f.root, "embeddings.sqlite")));
			assert.ok(!fs.existsSync(path.join(f.root, ".embeddings")));
		} finally { moved.close(); }
	} finally { f.cleanup(); }
});

test("corrupt embedding snapshots fall back to BM25 and block mutations", async () => {
	const f = fixture();
	try {
		await f.store.create({ path: "/invoice.md", type: "Note", body: "Invoice recovery instructions." });
		fs.writeFileSync(path.join(f.root, "embeddings.sqlite"), "not a SQLite database");
		assert.ok(f.store.lint().some((issue) => issue.kind === "malformed_embedding"));
		const found = await f.store.search({ query: "invoice" });
		assert.ok("results" in found);
		assert.equal(found.embeddingFallback, true);
		assert.deepEqual(found.results[0].matchedBy, ["bm25"]);
		await assert.rejects(f.store.remove("/invoice.md"), /Embedding snapshot is invalid/);
		assert.ok(fs.existsSync(path.join(f.root, "invoice.md")));
	} finally { f.cleanup(); }
});

test("a restored Markdown bundle rebuilds in-memory BM25 on restart", async () => {
	const f = fixture();
	try {
		await f.store.create({ path: "/restored.md", type: "Note", body: "Recover this exact phrase." });
		f.store.close();
		assert.ok(!fs.existsSync(path.join(f.root, "search.sqlite")));
		const restored = f.make(async () => { throw new Error("embedding unavailable during restore"); });
		try {
			const result = await restored.search({ query: "Recover" });
			assert.ok("results" in result);
			assert.equal(result.results[0].path, "/restored.md");
			assert.ok(!restored.lint().some((issue) => issue.kind === "missing_embedding"));
			assert.equal(snapshotRows(f.root).length, 1);
		} finally { restored.close(); }
	} finally { f.cleanup(); }
});

test("symlinked bundle or search database cannot escape the memory root", () => {
	const f = fixture();
	try {
		f.store.close();
		const outside = path.join(f.dir, "outside.sqlite");
		fs.writeFileSync(outside, "do not overwrite");
		fs.symlinkSync(outside, path.join(f.root, "search.sqlite"));
		assert.throws(() => f.make(), /Obsolete search index must be a regular file/);
		assert.equal(fs.readFileSync(outside, "utf8"), "do not overwrite");
		const alias = path.join(f.dir, "alias");
		fs.symlinkSync(f.root, alias);
		assert.throws(() => new MemoryStore({ root: alias, embed: vector }), /root must not be a symlink/);
	} finally { f.cleanup(); }
});

test("corrupt obsolete search cache is removed and BM25 rebuilds in memory", async () => {
	const f = fixture();
	try {
		await f.store.create({ path: "/recovered.md", type: "Note", body: "A recovered blue heron." });
		f.store.close();
		fs.writeFileSync(path.join(f.root, "search.sqlite"), "broken cache bytes");
		const rebuilt = f.make();
		try {
			const found = await rebuilt.search({ query: "heron" });
			assert.ok("results" in found);
			assert.deepEqual(found.results[0].matchedBy, ["bm25", "embedding"]);
			assert.ok(!fs.existsSync(path.join(f.root, "search.sqlite")));
		} finally { rebuilt.close(); }
	} finally { f.cleanup(); }
});

test("llama.cpp uses retrieval prefixes and checks dimensions", async () => {
	const requests: string[] = [];
	const mock = async (_url: string | URL | Request, init?: RequestInit) => {
		requests.push(String(init?.body));
		return new Response(JSON.stringify({ data: [{ embedding: Array<number>(DIMENSIONS).fill(0.1) }] }),
			{ status: 200, headers: { "content-type": "application/json" } });
	};
	const embed = createEmbedder(mock as typeof fetch);
	await embed("something", "query");
	await embed("another", "document");
	assert.deepEqual(requests.map((s) => JSON.parse(s).input), ["Query: something", "Document: another"]);
	assert.ok(requests.every((s) => JSON.parse(s).model === MODEL));
});
