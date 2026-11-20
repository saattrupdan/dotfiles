import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

async function fixture(mode, run) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lifecycle-unit-"));
	const temporary = path.join(root, "resources"), state = path.join(root, "container.json"), log = path.join(root, "operations");
	fs.mkdirSync(temporary);
	const container = path.join(root, "container.mjs");
	fs.writeFileSync(container, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const root = process.env.LIFECYCLE_TEST_ROOT, mode = process.env.LIFECYCLE_TEST_MODE;
const state = path.join(root, 'container.json'), operation = process.argv[2];
fs.appendFileSync(path.join(root, 'operations'), operation + '\\n');
if (operation === 'create') {
 fs.writeFileSync(path.join(root, 'guardian'), String(process.ppid));
 if (mode === 'late-create') await new Promise(resolve => setTimeout(resolve, 700));
 fs.writeFileSync(state, JSON.stringify({phase:'creating', guardian:process.ppid}));
 if (mode === 'slow-create') await new Promise(resolve => setTimeout(resolve, 700));
 if (mode === 'create-error') process.exit(7);
} else if (operation === 'start') {
 process.on('SIGWINCH', () => fs.appendFileSync(path.join(root, 'operations'), 'resize\\n'));
 fs.writeFileSync(state, JSON.stringify({phase:'running', guardian:process.ppid}));
 if (mode !== 'complete') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
} else if (operation === 'stop') {
 process.exit(1);
} else if (operation === 'delete' && mode !== 'cleanup-error') {
 fs.rmSync(state, {force:true});
} else if (operation === 'inspect' && !fs.existsSync(state)) {
 console.error('Error: container not found: pi-lifecycle-test'); process.exit(1);
}
`, { mode: 0o755 });
	const driver = path.join(root, "owner.mjs");
	fs.writeFileSync(driver, `import {runSandboxContainer} from ${JSON.stringify(new URL("./container-lifecycle.mjs", import.meta.url).href)};
try { process.exitCode = await runSandboxContainer(${JSON.stringify({ container, args: ["run", "--rm", "--name", "pi-lifecycle-test", "image"], name: "pi-lifecycle-test", temporary })}); }
catch (error) { console.error(error.message); process.exitCode = 1; }
`);
	const env = { ...process.env, LIFECYCLE_TEST_ROOT: root, LIFECYCLE_TEST_MODE: mode };
	const owner = spawn(process.execPath, [driver], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "", guardian;
	owner.stdout.resume(); owner.stderr.on("data", data => { stderr += data; });
	const finished = new Promise(resolve => owner.once("close", code => resolve(code)));
	const waitFor = async predicate => {
		for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(50); }
		assert.fail("Timed out waiting for lifecycle state: " + stderr);
	};
	try {
		await run({ owner, finished, state, temporary, log, waitFor, stderr: () => stderr,
			guardian: () => guardian,
			readyGuardian: async () => { const file = path.join(root, "guardian"); await waitFor(() => fs.existsSync(file)); guardian = Number(fs.readFileSync(file, "utf8")); },
			ready: async phase => { await waitFor(() => fs.existsSync(state) && JSON.parse(fs.readFileSync(state)).phase === phase); guardian = JSON.parse(fs.readFileSync(state)).guardian; },
		});
	} finally {
		if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
		await Promise.race([finished, delay(5000)]);
		if (guardian) { try { process.kill(guardian, "SIGKILL"); } catch {} }
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test("normal completion explicitly deletes the container and temporary resources", { timeout: 15000 }, async () => {
	await fixture("complete", async ({ finished, state, temporary, log }) => {
		assert.equal(await finished, 0);
		assert.ok(!fs.existsSync(state)); assert.ok(!fs.existsSync(temporary));
		assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["create", "start", "stop", "delete", "inspect"]);
	});
});

for (const signal of ["SIGHUP", "SIGTERM", "SIGKILL"]) {
	test(`detached container owner survives terminal process-group ${signal} to finish removal`, { timeout: 15000 }, async () => {
		await fixture("attached", async ({ owner, state, temporary, ready, waitFor }) => {
			await ready("running"); process.kill(-owner.pid, signal);
			await waitFor(() => !fs.existsSync(state) && !fs.existsSync(temporary));
		});
	});
}

test("closing during creation waits for acknowledgement and never starts the abandoned container", { timeout: 15000 }, async () => {
	await fixture("slow-create", async ({ owner, state, temporary, log, ready, waitFor }) => {
		await ready("creating"); process.kill(-owner.pid, "SIGKILL");
		await waitFor(() => !fs.existsSync(state) && !fs.existsSync(temporary));
		assert.ok(!fs.readFileSync(log, "utf8").includes("start"));
	});
});

test("terminal resize signals reach the detached attached client", { timeout: 15000 }, async () => {
	await fixture("attached", async ({ owner, ready, log, waitFor }) => {
		await ready("running"); owner.kill("SIGWINCH");
		await waitFor(() => fs.readFileSync(log, "utf8").includes("resize"));
		owner.kill("SIGTERM");
	});
});

test("guardian death during delayed registration waits for its create client before rescue cleanup", { timeout: 15000 }, async () => {
	await fixture("late-create", async ({ readyGuardian, guardian, finished, state, temporary, log }) => {
		await readyGuardian(); process.kill(guardian(), "SIGKILL");
		assert.equal(await finished, 1);
		assert.ok(!fs.existsSync(state)); assert.ok(!fs.existsSync(temporary));
		assert.ok(!fs.readFileSync(log, "utf8").includes("start"));
	});
});

test("guardian death while attached reaps its client before rescue removal", { timeout: 15000 }, async () => {
	await fixture("attached", async ({ ready, guardian, finished, state, temporary }) => {
		await ready("running"); process.kill(guardian(), "SIGKILL");
		assert.equal(await finished, 1);
		assert.ok(!fs.existsSync(state)); assert.ok(!fs.existsSync(temporary));
	});
});

test("creation errors remove partial container state and preserve the failure code", { timeout: 15000 }, async () => {
	await fixture("create-error", async ({ finished, state, temporary }) => {
		assert.equal(await finished, 7);
		assert.ok(!fs.existsSync(state)); assert.ok(!fs.existsSync(temporary));
	});
});

test("unconfirmed removal is reported and retains resources for the remaining container", { timeout: 15000 }, async () => {
	await fixture("cleanup-error", async ({ owner, finished, state, temporary, ready, stderr }) => {
		await ready("running"); owner.kill("SIGTERM");
		assert.equal(await finished, 1);
		assert.match(stderr(), /still exists after cleanup/);
		assert.ok(fs.existsSync(state)); assert.ok(fs.existsSync(temporary));
	});
});
