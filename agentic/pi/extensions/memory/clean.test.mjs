import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

import { runCleaning } from "./clean.mjs";

function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-clean-test-"));
	const root = path.join(dir, "memory"), agentDir = path.join(dir, "agent");
	fs.mkdirSync(root);
	fs.mkdirSync(path.join(agentDir, "bin"), { recursive: true });
	fs.writeFileSync(path.join(agentDir, "bin", "pi"), `#!/usr/bin/env node
if(process.env.PI_MEMORY_CLEANING_ONLY !== '1')process.exit(3);
if(process.env.PI_MEMORY_CLEAN_TEST_MODE === 'slow')setInterval(()=>{},1000);
else {
if(process.env.PI_MEMORY_CLEAN_TEST_MODE !== 'no-lint')console.log(JSON.stringify({type:'tool_execution_end',toolName:'lint_concepts',isError:false,result:{details:{issues:[{kind:'orphan'},{kind:'orphan'}]}}}));
if(process.env.PI_MEMORY_CLEAN_TEST_MODE === 'repair')console.log(JSON.stringify({type:'tool_execution_end',toolName:'update_concept',isError:false}));
if(process.env.PI_MEMORY_CLEAN_TEST_MODE === 'remove')console.log(JSON.stringify({type:'tool_execution_end',toolName:'remove_concept',isError:false,result:{details:{archive:'/requests/removed/example'}}}));
if(process.env.PI_MEMORY_CLEAN_TEST_MODE === 'fail')process.exit(1);
console.log(JSON.stringify({type:'agent_end'}));
}
`, { mode: 0o700 });
	return { root, agentDir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("maintenance logs successful bounded librarian work without leaking concept content", async () => {
	const f = fixture();
	const old = process.env.PI_MEMORY_CLEAN_TEST_MODE;
	try {
		process.env.PI_MEMORY_CLEAN_TEST_MODE = "repair";
		const result = await runCleaning({ root: f.root, agentDir: f.agentDir, timeoutMs: 3_000 });
		assert.equal(result.status, "done");
		assert.equal(result.repairs, 1);
		assert.deepEqual(result.issues, { orphan: 2 });
		assert.match(fs.readFileSync(path.join(f.root, "cleaning.log"), "utf8"), /done lint=1 updates=1 removals=0 issues=\{"orphan":2\}/);
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
		fs.writeFileSync(path.join(f.root, ".cleaning.lock"), "99999999");
		process.env.PI_MEMORY_CLEAN_TEST_MODE = "repair";
		assert.equal((await runCleaning({ root: f.root, agentDir: f.agentDir, timeoutMs: 3_000 })).status, "done");
		assert.match(fs.readFileSync(path.join(f.root, "cleaning.log"), "utf8"), /recovered-interrupted-run/);
	} finally { if (old === undefined) delete process.env.PI_MEMORY_CLEAN_TEST_MODE;
		else process.env.PI_MEMORY_CLEAN_TEST_MODE = old; f.cleanup(); }
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

test("maintenance skips a concurrently active run", async () => {
	const f = fixture();
	try {
		fs.writeFileSync(path.join(f.root, ".cleaning.lock"), String(process.pid));
		assert.deepEqual(await runCleaning({ root: f.root, agentDir: f.agentDir }),
			{ skipped: true, reason: "already running" });
	} finally { f.cleanup(); }
});
