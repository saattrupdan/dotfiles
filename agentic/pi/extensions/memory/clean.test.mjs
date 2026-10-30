import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { URL } from "node:url";

import { atomicJob, enqueue, jobFile, readJob } from "../memory-handoff/queue.mjs";

import { runCleaning } from "./clean.mjs";

function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-clean-test-"));
	const root = path.join(dir, "memory"), agentDir = path.join(dir, "agent");
	fs.mkdirSync(root);
	fs.mkdirSync(path.join(agentDir, "bin"), { recursive: true });
	fs.writeFileSync(path.join(agentDir, "bin", "pi"), `#!/usr/bin/env node
const fs=require('node:fs');
if(process.env.PI_MEMORY_CLEAN_TEST_CALLS)fs.appendFileSync(process.env.PI_MEMORY_CLEAN_TEST_CALLS,'run\\n');
if(process.env.PI_MEMORY_CLEANING_ONLY !== '1')process.exit(3);
if(process.env.PI_MEMORY_CLEAN_TEST_MODE === 'slow')setInterval(()=>{},1000);
else import(${JSON.stringify(new URL("./fingerprint.mjs", import.meta.url).href)}).then(({fingerprintBundle})=>{
const emitLint=(id)=>{
console.log(JSON.stringify({type:'tool_execution_start',toolName:'lint_concepts',toolCallId:id}));
console.log(JSON.stringify({type:'tool_execution_end',toolName:'lint_concepts',toolCallId:id,isError:false,result:{details:{issues:process.env.PI_MEMORY_CLEAN_TEST_MODE==='remaining'?[{kind:'broken_link',path:'/source.md'}]:[{kind:'orphan',path:'/a.md'},{kind:'orphan',path:'/b.md'}],fingerprint:process.env.PI_MEMORY_CLEAN_TEST_MODE==='stale-fingerprint'?'before':fingerprintBundle(${JSON.stringify(root)})}}}));
};
if(process.env.PI_MEMORY_CLEAN_TEST_MODE !== 'no-lint')emitLint('lint-1');
if(['repair','no-final-lint','remaining'].includes(process.env.PI_MEMORY_CLEAN_TEST_MODE))console.log(JSON.stringify({type:'tool_execution_end',toolName:'update_concept',isError:false}));
if(process.env.PI_MEMORY_CLEAN_TEST_MODE==='six-repairs')for(let n=0;n<6;n++)console.log(JSON.stringify({type:'tool_execution_end',toolName:'update_concept',isError:false}));
if(process.env.PI_MEMORY_CLEAN_TEST_MODE === 'remove')console.log(JSON.stringify({type:'tool_execution_end',toolName:'remove_concept',isError:false,result:{details:{archive:'/requests/removed/example'}}}));
if(['repair','remove','six-repairs','remaining'].includes(process.env.PI_MEMORY_CLEAN_TEST_MODE))emitLint('lint-2');
if(process.env.PI_MEMORY_CLEAN_TEST_MODE === 'fail')process.exit(1);
console.log(JSON.stringify({type:'agent_end'}));
}).catch((error)=>{console.error(error);process.exitCode=1});
`, { mode: 0o700 });
	return { root, agentDir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("maintenance logs successful librarian work without leaking concept content", async () => {
	const f = fixture();
	const old = process.env.PI_MEMORY_CLEAN_TEST_MODE;
	try {
		process.env.PI_MEMORY_CLEAN_TEST_MODE = "repair";
		const result = await runCleaning({ root: f.root, agentDir: f.agentDir, timeoutMs: 3_000 });
		assert.equal(result.status, "done");
		assert.equal(result.repairs, 1);
		assert.deepEqual(result.issues, { orphan: 2 });
		assert.match(fs.readFileSync(path.join(f.root, "cleaning.log"), "utf8"), /done lint=2 updates=1 removals=0 issues=\{"orphan":2\}/);
		assert.equal(fs.statSync(path.join(f.root, "cleaning.log")).mode & 0o777, 0o600);
		assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, ".cleaning-state.json"), "utf8")).status, "done");
		assert.ok(!fs.existsSync(path.join(f.root, ".cleaning.lock")));
	} finally { if (old === undefined) delete process.env.PI_MEMORY_CLEAN_TEST_MODE;
		else process.env.PI_MEMORY_CLEAN_TEST_MODE = old; f.cleanup(); }
});

test("failed and interrupted sessions log errors and retry from fresh lint", async () => {
	const f = fixture();
	const old = process.env.PI_MEMORY_CLEAN_TEST_MODE;
	try {
		process.env.PI_MEMORY_CLEAN_TEST_MODE = "no-lint";
		assert.equal((await runCleaning({ root: f.root, agentDir: f.agentDir, timeoutMs: 3_000 })).status, "failed");
		process.env.PI_MEMORY_CLEAN_TEST_MODE = "slow";
		assert.match((await runCleaning({ root: f.root, agentDir: f.agentDir, timeoutMs: 100 })).error, /timed out/);
		process.env.PI_MEMORY_CLEAN_TEST_MODE = "no-final-lint";
		assert.match((await runCleaning({ root: f.root, agentDir: f.agentDir, timeoutMs: 3_000 })).error, /finalLint=false/);
		fs.writeFileSync(path.join(f.root, ".cleaning.lock"), "99999999");
		process.env.PI_MEMORY_CLEAN_TEST_MODE = "repair";
		assert.equal((await runCleaning({ root: f.root, agentDir: f.agentDir, timeoutMs: 3_000 })).status, "done");
		assert.match(fs.readFileSync(path.join(f.root, "cleaning.log"), "utf8"), /recovered-interrupted-run/);
	} finally { if (old === undefined) delete process.env.PI_MEMORY_CLEAN_TEST_MODE;
		else process.env.PI_MEMORY_CLEAN_TEST_MODE = old; f.cleanup(); }
});

test("more than five repairs complete when final lint has no actionable issues", async () => {
	const f = fixture();
	const old = process.env.PI_MEMORY_CLEAN_TEST_MODE;
	try {
		process.env.PI_MEMORY_CLEAN_TEST_MODE = "six-repairs";
		const result = await runCleaning({ root: f.root, agentDir: f.agentDir, timeoutMs: 3_000 });
		assert.equal(result.status, "done");
		assert.equal(result.repairs, 6);
	} finally { if (old === undefined) delete process.env.PI_MEMORY_CLEAN_TEST_MODE;
		else process.env.PI_MEMORY_CLEAN_TEST_MODE = old; f.cleanup(); }
});

test("remaining lint errors fail the run and are retried even when the bundle is unchanged", async () => {
	const f = fixture();
	const oldMode = process.env.PI_MEMORY_CLEAN_TEST_MODE;
	const oldCalls = process.env.PI_MEMORY_CLEAN_TEST_CALLS;
	try {
		process.env.PI_MEMORY_CLEAN_TEST_MODE = "remaining";
		const calls = path.join(f.root, "calls.txt");
		process.env.PI_MEMORY_CLEAN_TEST_CALLS = calls;
		for (let n = 0; n < 2; n++) {
			const result = await runCleaning({ root: f.root, agentDir: f.agentDir, timeoutMs: 3_000 });
			assert.equal(result.status, "failed");
			assert.match(result.error, /remaining=\{"broken_link":1\}/);
		}
		assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 2);
		assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, ".cleaning-state.json"), "utf8")).status, "failed");
	} finally {
		if (oldMode === undefined) delete process.env.PI_MEMORY_CLEAN_TEST_MODE;
		else process.env.PI_MEMORY_CLEAN_TEST_MODE = oldMode;
		if (oldCalls === undefined) delete process.env.PI_MEMORY_CLEAN_TEST_CALLS;
		else process.env.PI_MEMORY_CLEAN_TEST_CALLS = oldCalls;
		f.cleanup();
	}
});

test("successful removals record reversible archive paths", async () => {
	const f = fixture();
	const old = process.env.PI_MEMORY_CLEAN_TEST_MODE;
	try {
		process.env.PI_MEMORY_CLEAN_TEST_MODE = "remove";
		const result = await runCleaning({ root: f.root, agentDir: f.agentDir, timeoutMs: 3_000 });
		assert.equal(result.removals, 1);
		assert.deepEqual(result.archives, ["/requests/removed/example"]);
		assert.match(fs.readFileSync(path.join(f.root, "cleaning.log"), "utf8"), /archives=\/requests\/removed\/example/);
	} finally { if (old === undefined) delete process.env.PI_MEMORY_CLEAN_TEST_MODE;
		else process.env.PI_MEMORY_CLEAN_TEST_MODE = old; f.cleanup(); }
});

test("unchanged bundle skips the model and logs; a same-size hand edit runs it again", async () => {
	const f = fixture();
	const previous = process.env.PI_MEMORY_CLEAN_TEST_CALLS;
	try {
		const calls = path.join(f.root, "calls.txt");
		const concept = path.join(f.root, "fact.md");
		fs.writeFileSync(concept, "before");
		process.env.PI_MEMORY_CLEAN_TEST_CALLS = calls;
		assert.equal((await runCleaning({ root: f.root, agentDir: f.agentDir, timeoutMs: 3_000 })).status, "done");
		const logBefore = fs.readFileSync(path.join(f.root, "cleaning.log"), "utf8");
		fs.writeFileSync(path.join(f.root, ".snapshot-cache"), "updated");
		assert.deepEqual(await runCleaning({ root: f.root, agentDir: f.agentDir }),
			{ skipped: true, reason: "memory unchanged" });
		assert.equal(fs.readFileSync(path.join(f.root, "cleaning.log"), "utf8"), logBefore);
		fs.writeFileSync(concept, "after!");
		assert.equal((await runCleaning({ root: f.root, agentDir: f.agentDir, timeoutMs: 3_000 })).status, "done");
		assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 2);
	} finally { if (previous === undefined) delete process.env.PI_MEMORY_CLEAN_TEST_CALLS;
		else process.env.PI_MEMORY_CLEAN_TEST_CALLS = previous; f.cleanup(); }
});

test("a write after lint inspection cannot be checkpointed as clean", async () => {
	const f = fixture();
	const previous = process.env.PI_MEMORY_CLEAN_TEST_MODE;
	try {
		process.env.PI_MEMORY_CLEAN_TEST_MODE = "stale-fingerprint";
		let reads = 0;
		const fingerprint = () => ++reads === 1 ? "before" : "after";
		const result = await runCleaning({ root: f.root, agentDir: f.agentDir, fingerprint, timeoutMs: 3_000 });
		assert.equal(result.status, "failed");
		assert.match(result.error, /fingerprint=false/);
		assert.equal((await runCleaning({ root: f.root, agentDir: f.agentDir, fingerprint, timeoutMs: 3_000 })).status, "failed");
	} finally { if (previous === undefined) delete process.env.PI_MEMORY_CLEAN_TEST_MODE;
		else process.env.PI_MEMORY_CLEAN_TEST_MODE = previous; f.cleanup(); }
});

test("new failed requests get review without running unchanged concept cleanup again", async () => {
	const f = fixture();
	const previous = process.env.PI_MEMORY_CLEAN_TEST_CALLS;
	try {
		const calls = path.join(f.root, "calls.txt");
		process.env.PI_MEMORY_CLEAN_TEST_CALLS = calls;
		await runCleaning({ root: f.root, agentDir: f.agentDir, timeoutMs: 3_000 });
		const id = enqueue("a missing fact", f.root);
		fs.renameSync(jobFile(f.root, "pending", id), jobFile(f.root, "failed", id));
		const file = jobFile(f.root, "failed", id);
		atomicJob(file, { ...readJob(f.root, "failed", id), attempts: 1, unknownOutcome: true, failedAt: new Date().toISOString() });
		let reviews = 0;
		const recover = async () => { reviews++; return { errors: 0, needsReview: 1 }; };
		const result = await runCleaning({ root: f.root, agentDir: f.agentDir, recover });
		assert.equal(result.cleaningSkipped, true);
		assert.equal(reviews, 1);
		assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 1);
		assert.equal((await runCleaning({ root: f.root, agentDir: f.agentDir, recover })).skipped, true);
		assert.equal(reviews, 1);
		atomicJob(file, { ...readJob(f.root, "failed", id), attempts: 2, failedAt: new Date(Date.now() + 1000).toISOString() });
		await runCleaning({ root: f.root, agentDir: f.agentDir, recover });
		assert.equal(reviews, 2);
	} finally { if (previous === undefined) delete process.env.PI_MEMORY_CLEAN_TEST_CALLS;
		else process.env.PI_MEMORY_CLEAN_TEST_CALLS = previous; f.cleanup(); }
});

test("active queue defers concept cleaning but still handles safe failed retries", async () => {
	const f = fixture();
	try {
		enqueue("pending", f.root);
		const id = enqueue("definitely not stored", f.root);
		fs.renameSync(jobFile(f.root, "pending", id), jobFile(f.root, "failed", id));
		let woke = 0, reviewed = 0;
		const result = await runCleaning({ root: f.root, agentDir: f.agentDir,
			wakeQueue: () => { woke++; },
			recover: async (options) => { assert.equal(options.onlyDefinite, true); reviewed++; return { retried: 1, errors: 0 }; } });
		assert.equal(result.skipped, true);
		assert.equal(woke, 1);
		assert.equal(reviewed, 1);
		assert.ok(!fs.existsSync(path.join(f.root, ".cleaning-state.json")));
	} finally { f.cleanup(); }
});

test("maintenance skips a concurrently active run", async () => {
	const f = fixture();
	try {
		fs.writeFileSync(path.join(f.root, ".cleaning.lock"), String(process.pid));
		assert.deepEqual(await runCleaning({ root: f.root, agentDir: f.agentDir }),
			{ skipped: true, reason: "already running" });
	} finally { f.cleanup(); }
});
