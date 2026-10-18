import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { inventory, prepare } from "./migrate.mjs";

function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-migration-test-"));
	const source = path.join(dir, "source"), stage = path.join(dir, "stage");
	fs.mkdirSync(source);
	return { dir, source, stage, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const embed = async () => Array(1024).fill(0.1);

test("stages an exact source copy, splits oversize concepts and builds vectors without changing source", async () => {
	const f = fixture();
	try {
		fs.writeFileSync(path.join(f.source, "one.md"), "---\ntype: Note\ntitle: One\n---\n\nA first concept.\n");
		fs.writeFileSync(path.join(f.source, "large.md"), `---\ntype: Note\n---\n\n${"Long passage with preserved text.\n\n".repeat(950)}`);
		fs.writeFileSync(path.join(f.source, "metadata.md"),
			`---\ntype: Note\ndescription: ${"long".repeat(560)}\n---\n\n${"Large metadata and preserved body.\n\n".repeat(950)}`);
		const original = inventory(f.source);
		const progress = [];
		const result = await prepare({ source: f.source, stage: f.stage, embed, progress: (step) => progress.push(step) });
		assert.deepEqual(inventory(f.source), original);
		assert.deepEqual(result.source, original);
		assert.equal(result.splitConcepts, 2);
		assert.deepEqual(result.preservation, { checked: 3, split: 2 });
		assert.ok(result.conceptCount > 2);
		assert.equal(result.lint.missing_embedding, undefined);
		assert.ok(fs.existsSync(path.join(f.stage, "embeddings.sqlite")));
		assert.ok(!fs.existsSync(path.join(f.stage, "requests")));
		assert.ok(!fs.existsSync(path.join(f.source, "embeddings.sqlite")));
		assert.ok(progress.some((event) => event.phase === "embedding"));
		await assert.rejects(prepare({ source: f.source, stage: f.stage, embed }), /already exists/);
	} finally { f.cleanup(); }
});

test("invalid source concepts fail closed and leave source unchanged", async () => {
	const f = fixture();
	try {
		fs.writeFileSync(path.join(f.source, "bad.md"), "No OKF frontmatter.");
		const original = inventory(f.source);
		await assert.rejects(prepare({ source: f.source, stage: f.stage, embed }), /invalid concepts/);
		assert.deepEqual(inventory(f.source), original);
		assert.ok(fs.existsSync(f.stage));
	} finally { f.cleanup(); }
});

test("symlinked source entries cannot escape the staging copy", () => {
	const f = fixture();
	try {
		fs.symlinkSync(f.dir, path.join(f.source, "external"));
		assert.throws(() => inventory(f.source), /unsupported symlink/);
	} finally { f.cleanup(); }
});
