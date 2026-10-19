import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers";

import { atomicJob, counts, enqueue, jobFile, queueRoot, readJob, retry } from "../memory-handoff/queue.mjs";
import { recoverFailed, reviewRequest } from "./failed-requests.mjs";

function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-failed-test-"));
	const root = path.join(dir, "memory"), agentDir = path.join(dir, "agent");
	fs.mkdirSync(root);
	fs.mkdirSync(path.join(agentDir, "bin"), { recursive: true });
	fs.writeFileSync(path.join(agentDir, "bin", "pi"), `#!/usr/bin/env node
const fs=require('node:fs');
if(process.env.PI_MEMORY_RECALL_ONLY!=='1'||process.env.PI_MEMORY_CLEANING_ONLY!=='0')process.exit(3);
const text=fs.readFileSync(process.argv.at(-1).slice(1),'utf8');
if(text.includes('slow'))setInterval(()=>{},1000);
else if(text.includes('no-search'))console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'{"status":"absent"}'}]}}));
else {
if(!text.includes('path-only'))console.log(JSON.stringify({type:'tool_execution_end',toolName:'search_concepts',isError:false,result:{details:{results:[{path:'/known.md'}]}}}));
console.log(JSON.stringify({type:'tool_execution_end',toolName:'search_concepts',isError:false,result:{details:{path:'/known.md'}}}));
const status=text.includes('present')?'present':'absent';
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify({status,evidence:['/known.md']})}]}}));
}
`, { mode: 0o700 });
	const failed = (text, unknownOutcome = true, attempts = 1) => {
		const id = enqueue(text, root);
		fs.renameSync(jobFile(root, "pending", id), jobFile(root, "failed", id));
		const file = jobFile(root, "failed", id);
		atomicJob(file, { ...readJob(root, "failed", id), attempts, unknownOutcome, error: "Interrupted" });
		return id;
	};
	return { root, agentDir, failed, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("uncertain jobs require a real read-only search before declaring facts absent or present", async () => {
	const f = fixture();
	try {
		assert.deepEqual(await reviewRequest({ id: "1", text: "new fact" }, f.agentDir, f.root), { status: "absent" });
		assert.deepEqual(await reviewRequest({ id: "2", text: "present fact" }, f.agentDir, f.root),
			{ status: "present", evidence: ["/known.md"] });
		assert.deepEqual(await reviewRequest({ id: "3", text: "no-search fact" }, f.agentDir, f.root),
			{ status: "uncertain" });
		assert.deepEqual(await reviewRequest({ id: "4", text: "path-only fact" }, f.agentDir, f.root),
			{ status: "uncertain" });
	} finally { f.cleanup(); }
});

test("hourly recovery retries bounded absent jobs, resolves present jobs and retains ambiguous jobs", async () => {
	const f = fixture();
	try {
		const absent = f.failed("absent fact");
		const present = f.failed("present fact");
		const ambiguous = f.failed("ambiguous fact");
		const definite = f.failed("definitely not stored", false);
		const exhausted = f.failed("old fact", true, 3);
		const woken = [];
		const review = async (job) => job.id === absent ? { status: "absent" } :
			job.id === present ? { status: "present", evidence: ["/known.md"] } : { status: "uncertain" };
		const first = await recoverFailed({ root: f.root, agentDir: f.agentDir, review,
			wakeJobs: (root) => woken.push(root), max: 4 });
		assert.equal(first.retried, 2);
		assert.equal(first.alreadyPresent, 1);
		assert.equal(first.needsReview, 1);
		assert.equal(first.errors, 0);
		assert.equal(woken.length, 1);
		assert.equal(counts(f.root).failed, 2);
		assert.equal(readJob(f.root, "done", present).resolution, "verified already present");
		assert.equal(readJob(f.root, "failed", ambiguous).reviewStatus, "uncertain");
		assert.equal(readJob(f.root, "pending", absent).unknownOutcome, undefined);
		assert.equal(readJob(f.root, "pending", definite).unknownOutcome, undefined);
		assert.equal(readJob(f.root, "failed", exhausted).attempts, 3);
	} finally { f.cleanup(); }
});

test("manual retry racing with review cannot recreate a failed copy", async () => {
	const f = fixture();
	try {
		const id = f.failed("interrupted fact");
		const result = await recoverFailed({ root: f.root, agentDir: f.agentDir,
			review: async () => { retry(f.root, id, true); return { status: "uncertain" }; },
			wakeJobs: () => assert.fail("manual retry already owns the pending job") });
		assert.equal(result.errors, 1);
		assert.deepEqual(counts(f.root), { pending: 1, running: 0, failed: 0, done: 0 });
	} finally { f.cleanup(); }
});

test("interrupted reviews leave their request failed without replay", async () => {
	const f = fixture();
	try {
		const id = f.failed("interrupted fact");
		const controller = new globalThis.AbortController();
		const result = await recoverFailed({ root: f.root, agentDir: f.agentDir, signal: controller.signal,
			review: async () => { controller.abort(); return { status: "absent" }; },
			wakeJobs: () => assert.fail("must not replay after interruption") });
		assert.equal(result.skipped, 1);
		assert.deepEqual(counts(f.root), { pending: 0, running: 0, failed: 1, done: 0 });
		assert.ok(fs.existsSync(jobFile(f.root, "failed", id)));
		const abort = new globalThis.AbortController();
		const request = reviewRequest({ id: "slow", text: "slow fact" }, f.agentDir, f.root, 3_000, abort.signal);
		setTimeout(() => abort.abort(), 50);
		assert.deepEqual(await request, { status: "uncertain" });
	} finally { f.cleanup(); }
});

test("a paused queue is not replayed by hourly cleanup", async () => {
	const f = fixture();
	try {
		const id = f.failed("later", false);
		fs.writeFileSync(path.join(queueRoot(f.root), "paused"), "paused\n");
		const result = await recoverFailed({ root: f.root, agentDir: f.agentDir, wakeJobs: () => assert.fail("must not wake") });
		assert.equal(result.paused, true);
		assert.ok(fs.existsSync(jobFile(f.root, "failed", id)));
	} finally { f.cleanup(); }
});
