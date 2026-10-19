import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { atomicJob, enqueue, jobFile, readJob } from "../memory-handoff/queue.mjs";
import { failedWorkSignature, fingerprintBundle } from "./fingerprint.mjs";

function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-fingerprint-test-"));
	const root = path.join(dir, "memory");
	fs.mkdirSync(root);
	return { root, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("content fingerprint catches same-size edits, renames and vector changes, not cleaner bookkeeping", () => {
	const f = fixture();
	try {
		const folder = path.join(f.root, "people");
		fs.mkdirSync(folder);
		const concept = path.join(folder, "dan.md");
		fs.writeFileSync(concept, "alpha");
		fs.writeFileSync(path.join(f.root, "embeddings.sqlite"), "vectors1");
		const first = fingerprintBundle(f.root);
		fs.mkdirSync(path.join(f.root, "requests", "removed"), { recursive: true });
		fs.writeFileSync(path.join(f.root, "requests", "removed", "old.md"), "archived");
		fs.writeFileSync(path.join(f.root, "cleaning.log"), "finished");
		fs.writeFileSync(path.join(f.root, ".cleaning-state.json"), "{}");
		fs.writeFileSync(path.join(folder, "index.md"), "generated catalog");
		assert.equal(fingerprintBundle(f.root), first);
		const timestamp = fs.statSync(concept).mtime;
		fs.writeFileSync(concept, "bravo");
		fs.utimesSync(concept, timestamp, timestamp);
		const edited = fingerprintBundle(f.root);
		assert.notEqual(edited, first);
		fs.renameSync(concept, path.join(folder, "renamed.md"));
		const renamed = fingerprintBundle(f.root);
		assert.notEqual(renamed, edited);
		fs.writeFileSync(path.join(f.root, "embeddings.sqlite"), "vectors2");
		assert.notEqual(fingerprintBundle(f.root), renamed);
	} finally { f.cleanup(); }
});

test("failed-work signature ignores review bookkeeping but notices new failure attempts", () => {
	const f = fixture();
	try {
		const empty = failedWorkSignature(f.root);
		const id = enqueue("a fact", f.root);
		fs.renameSync(jobFile(f.root, "pending", id), jobFile(f.root, "failed", id));
		const file = jobFile(f.root, "failed", id);
		const job = { ...readJob(f.root, "failed", id), attempts: 1, failedAt: new Date().toISOString(), unknownOutcome: true };
		atomicJob(file, job);
		const failed = failedWorkSignature(f.root);
		assert.notEqual(failed, empty);
		atomicJob(file, { ...job, reviewedAt: new Date().toISOString(), reviewStatus: "uncertain" });
		assert.equal(failedWorkSignature(f.root), failed);
		atomicJob(file, { ...job, text: "a changed fact" });
		assert.notEqual(failedWorkSignature(f.root), failed);
		atomicJob(file, { ...job, attempts: 2, failedAt: new Date(Date.now() + 1000).toISOString() });
		assert.notEqual(failedWorkSignature(f.root), failed);
		const retriedAt = Date.now();
		atomicJob(file, { ...job, attempts: 2, retriedAt: new Date(retriedAt).toISOString() });
		assert.equal(failedWorkSignature(f.root, retriedAt), empty);
		assert.notEqual(failedWorkSignature(f.root, retriedAt + 60 * 60_000), empty);
		atomicJob(file, { ...job, attempts: 3 });
		assert.equal(failedWorkSignature(f.root), empty);
	} finally { f.cleanup(); }
});

test("active-tree symlinks fail closed instead of fingerprinting outside memory", () => {
	const f = fixture();
	try {
		fs.symlinkSync(f.root, path.join(f.root, "escape"));
		assert.throws(() => fingerprintBundle(f.root), /Symlink/);
	} finally { f.cleanup(); }
});
