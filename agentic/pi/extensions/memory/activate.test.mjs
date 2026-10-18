import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { activate } from "./activate.mjs";

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-activation-test-"));
	const stage = path.join(root, ".migration-stage"), requests = path.join(root, "requests");
	fs.mkdirSync(stage); fs.mkdirSync(requests);
	for (const state of ["pending", "running", "done", "failed"]) fs.mkdirSync(path.join(requests, state));
	fs.writeFileSync(path.join(requests, "paused"), "paused\n");
	fs.writeFileSync(path.join(root, "index.md"), "pilot index");
	fs.writeFileSync(path.join(stage, "index.md"), "migrated index");
	fs.writeFileSync(path.join(stage, "embeddings.sqlite"), "verified vector fixture");
	fs.writeFileSync(path.join(stage, ".migration-report.json"), "{}");
	return { root, stage, requests, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("activation archives the pilot and preserves queued request state", () => {
	const f = fixture();
	try {
		fs.writeFileSync(path.join(f.requests, "done", "receipt.json"), "completed job");
		const result = activate(f.root);
		assert.equal(result.installedEntries, 3);
		assert.equal(fs.readFileSync(path.join(f.root, "index.md"), "utf8"), "migrated index");
		assert.equal(fs.readFileSync(path.join(f.requests, "pilot-archive", "index.md"), "utf8"), "pilot index");
		assert.equal(fs.readFileSync(path.join(f.requests, "done", "receipt.json"), "utf8"), "completed job");
		assert.ok(!fs.existsSync(f.stage));
	} finally { f.cleanup(); }
});

test("activation refuses in-flight requests and leaves both bundles intact", () => {
	const f = fixture();
	try {
		fs.writeFileSync(path.join(f.requests, "pending", "queued.json"), "pending job");
		assert.throws(() => activate(f.root), /in flight/);
		assert.equal(fs.readFileSync(path.join(f.root, "index.md"), "utf8"), "pilot index");
		assert.equal(fs.readFileSync(path.join(f.stage, "index.md"), "utf8"), "migrated index");
		assert.ok(!fs.existsSync(path.join(f.requests, "pilot-archive")));
	} finally { f.cleanup(); }
});
