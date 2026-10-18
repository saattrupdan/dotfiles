import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { counts, defaultRoot, enqueue, jobFile, list, queueRoot, readJob, retry, workerPath, wake } from "./queue.mjs";

function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-queue-test-"));
	const root = path.join(dir, "memory"), agentDir = path.join(dir, "agent");
	fs.mkdirSync(root);
	fs.mkdirSync(path.join(agentDir, "bin"), { recursive: true });
	const fake = path.join(agentDir, "bin", "pi");
	fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const text = fs.readFileSync(process.argv.at(-1).slice(1), 'utf8');
fs.appendFileSync(process.env.PI_QUEUE_TEST_CALLS, text + '\\n');
const failure = text.includes('fail') && process.env.PI_QUEUE_TEST_RECOVER !== '1';
const noWrite = text.includes('no-write');
if (!noWrite) console.log(JSON.stringify({type:'tool_execution_end', toolName:'create_concept', isError:failure}));
console.log(JSON.stringify({type:'agent_end'}));
`, { mode: 0o700 });
	const calls = path.join(dir, "calls.txt");
	const work = (env = {}) => spawnSync(process.execPath, [workerPath(), "--root", root, "--agent-dir", agentDir], {
		encoding: "utf8", env: { ...process.env, PI_QUEUE_TEST_CALLS: calls, ...env }, timeout: 12_000,
	});
	return { dir, root, agentDir, calls, work, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("private durable queue acknowledges immediately, drains in order, and retains failures", () => {
	const f = fixture();
	try {
		const first = enqueue("first fact", f.root), bad = enqueue("fail fact", f.root);
		const third = enqueue("third fact", f.root);
		assert.equal(fs.statSync(jobFile(f.root, "pending", first)).mode & 0o777, 0o600);
		assert.equal(fs.statSync(queueRoot(f.root)).mode & 0o777, 0o700);
		assert.deepEqual(counts(f.root), { pending: 3, running: 0, failed: 0, done: 0 });
		const result = f.work();
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(fs.readFileSync(f.calls, "utf8").trim().split("\n"), ["first fact", "fail fact", "third fact"]);
		assert.deepEqual(counts(f.root), { pending: 0, running: 0, failed: 1, done: 2 });
		assert.equal(readJob(f.root, "failed", bad).unknownOutcome, true);
		assert.equal(readJob(f.root, "failed", bad).text, "fail fact");
		assert.throws(() => retry(f.root, bad), /verify the concept first/);
		retry(f.root, bad, true);
		assert.equal(f.work({ PI_QUEUE_TEST_RECOVER: "1" }).status, 0);
		assert.deepEqual(counts(f.root), { pending: 0, running: 0, failed: 0, done: 3 });
		assert.equal(readJob(f.root, "done", bad).writes, 1);
		assert.equal(readJob(f.root, "done", third).writes, 1);
	} finally { f.cleanup(); }
});

test("interrupted writes are quarantined; no-write failures can be retried", () => {
	const f = fixture();
	try {
		const interrupted = enqueue("possibly stored", f.root);
		fs.renameSync(jobFile(f.root, "pending", interrupted), jobFile(f.root, "running", interrupted));
		const noWrite = enqueue("no-write request", f.root);
		assert.equal(f.work().status, 0);
		assert.equal(readJob(f.root, "failed", interrupted).unknownOutcome, true);
		assert.equal(readJob(f.root, "failed", noWrite).unknownOutcome, false);
		assert.deepEqual(fs.readFileSync(f.calls, "utf8").trim().split("\n"), ["no-write request"]);
		retry(f.root, noWrite);
		assert.deepEqual(list(f.root), [noWrite]);
	} finally { f.cleanup(); }
});

test("next session quarantines an interrupted write with no other pending jobs", async () => {
	const f = fixture();
	try {
		const id = enqueue("may already be stored", f.root);
		fs.renameSync(jobFile(f.root, "pending", id), jobFile(f.root, "running", id));
		fs.writeFileSync(path.join(queueRoot(f.root), "worker.pid"), "99999999");
		wake(f.root, f.agentDir);
		for (let n = 0; n < 60 && !fs.existsSync(jobFile(f.root, "failed", id)); n++) await sleep(50);
		assert.equal(readJob(f.root, "failed", id).unknownOutcome, true);
		assert.ok(!fs.existsSync(f.calls), "uncertain write must not be replayed");
		assert.deepEqual(counts(f.root), { pending: 0, running: 0, failed: 1, done: 0 });
	} finally { f.cleanup(); }
});

test("queue rejects empty input, oversized text, and symlinked state", () => {
	const f = fixture();
	try {
		assert.throws(() => enqueue("   ", f.root), /must not be empty/);
		assert.throws(() => enqueue("x".repeat(128_001), f.root), /128 KB/);
		assert.equal(typeof defaultRoot(), "string");
		const external = path.join(f.dir, "external");
		fs.mkdirSync(external);
		fs.symlinkSync(external, path.join(f.root, "requests"));
		assert.throws(() => enqueue("test", f.root), /real directory/);
		assert.deepEqual(fs.readdirSync(external), []);
	} finally { f.cleanup(); }
});
