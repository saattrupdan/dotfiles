import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { collectConcepts, refreshCache, renderNativeSnapshot, restoreSnapshotFromCache } from "./native-refresh.mjs";

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-snapshot-test-"));
	return { root, paths: { cacheFile: path.join(root, ".snapshot", "cache.json"),
		snapshotFile: path.join(root, ".snapshot", "current.md") },
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("empty and large bundles have bounded metadata-only native snapshots", async () => {
	const f = fixture();
	try {
		assert.match(renderNativeSnapshot(collectConcepts(f.root)), /Concepts: 0/);
		fs.mkdirSync(path.join(f.root, "requests"));
		fs.writeFileSync(path.join(f.root, "requests", "failed.json"), '{"text":"private request"}');
		for (let i = 0; i < 75; i++) fs.writeFileSync(path.join(f.root, `concept-${i}.md`),
			`---\ntype: Note\ntitle: Concept ${i}\ndescription: Brief | summary\n---\n\nSecret body ${i}.`);
		const snapshot = renderNativeSnapshot(collectConcepts(f.root));
		assert.match(snapshot, /Concepts: 75/);
		assert.equal(snapshot.split("\n").filter((line) => line.startsWith("| Concept ")).length, 20);
		assert.doesNotMatch(snapshot, /Secret body|private request/);
		assert.doesNotMatch(snapshot, /Brief \| summary/);
		assert.match(snapshot, /recall_memory/);
		const updated = await refreshCache({ root: f.root, paths: f.paths, now: 1234 });
		assert.equal(updated.refreshed, true);
		assert.equal(fs.statSync(f.paths.cacheFile).mode & 0o777, 0o600);
	} finally { f.cleanup(); }
});

test("malformed concepts preserve last-known-good cache and snapshot", async () => {
	const f = fixture();
	try {
		fs.writeFileSync(path.join(f.root, "valid.md"), "---\ntype: Note\n---\n\nA memory.");
		assert.equal((await refreshCache({ root: f.root, paths: f.paths, now: 1234 })).refreshed, true);
		const before = fs.readFileSync(f.paths.snapshotFile, "utf8");
		fs.writeFileSync(path.join(f.root, "bad.md"), "Missing frontmatter");
		const result = await refreshCache({ root: f.root, paths: f.paths, now: 5678 });
		assert.equal(result.refreshed, false);
		assert.equal(fs.readFileSync(f.paths.snapshotFile, "utf8"), before);
		fs.unlinkSync(f.paths.snapshotFile);
		assert.equal(restoreSnapshotFromCache(f.paths, result.cache), true);
		assert.equal(fs.readFileSync(f.paths.snapshotFile, "utf8"), before);
	} finally { f.cleanup(); }
});
