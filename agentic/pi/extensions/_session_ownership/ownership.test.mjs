import process from "node:process";
import { URL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	acquire,
	inspect,
	release,
	newOwner,
	reserveNamespace,
	releaseNamespace,
	adopt,
	historyInScope,
} from "./ownership.mjs";
const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-owner-test-"));
test("exclusive ownership, owner-only release and namespace exclusion", () => {
	const root = fixture();
	try {
		const a = newOwner(),
			b = newOwner();
		const file = path.join(root, "session.jsonl");
		acquire(file, a, root);
		assert.throws(() => acquire(file, b, root), /owned/);
		release(file, b, root);
		assert.equal(inspect(file, root).instanceId, a.instanceId);
		release(file, a, root);
		reserveNamespace(a, root);
		assert.throws(() => acquire(file, b, root), /owned/);
		releaseNamespace(a, root);
		acquire(file, b, root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
test("canonical aliases cannot obtain a second lease", () => {
	const root = fixture();
	try {
		const real = path.join(root, "real");
		fs.mkdirSync(real);
		fs.symlinkSync(real, path.join(root, "alias"));
		const a = newOwner();
		acquire(path.join(real, "history"), a, root);
		assert.throws(() => acquire(path.join(root, "alias", "history"), newOwner(), root), /owned/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
test("dead process locks are reclaimed, never a live process by elapsed time", async () => {
	const root = fixture();
	const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
	await once(child, "spawn");
	try {
		const owner = newOwner("tmux", child.pid);
		const file = path.join(root, "saved");
		acquire(file, owner, root);
		assert.throws(() => acquire(file, newOwner(), root), /owned/);
		child.kill();
		await once(child, "exit");
		acquire(file, newOwner(), root);
	} finally {
		child.kill();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
test("bootstrap adoption requires the original reservation", () => {
	const root = fixture();
	try {
		const old = newOwner(),
			next = newOwner();
		const file = path.join(root, "saved");
		assert.throws(() => adopt(old, next, root), /lost/);
		reserveNamespace(old, root);
		acquire(file, old, root);
		adopt(old, next, root);
		assert.equal(inspect(file, root).pid, next.pid);
		assert.equal(inspect(file, root).instanceId, old.instanceId);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
test("multiple processes race for exactly one native-file lock", async () => {
	const root = fixture();
	try {
		const module = new URL("./ownership.mjs", import.meta.url).href;
		const script = `import{acquire,newOwner}from ${JSON.stringify(module)};try{acquire(process.argv[1],newOwner(),process.argv[2]);console.log('winner');setTimeout(()=>{},1200)}catch{console.log('denied')}`;
		const children = Array.from({ length: 5 }, () =>
			spawn(
				process.execPath,
				["--input-type=module", "-e", script, path.join(root, "shared"), root],
				{ stdio: ["ignore", "pipe", "ignore"] },
			),
		);
		const output = await Promise.all(
			children.map(async (c) => {
				let text = "";
				c.stdout.on("data", (d) => (text += d));
				await once(c, "exit");
				return text;
			}),
		);
		assert.equal(output.filter((s) => s.includes("winner")).length, 1);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
test("pilot scope blocks legacy acquisition and bootstrap adoption before mutation", () => {
	const root = fixture(), previous = process.env.PI_SESSION_HISTORY_SCOPE;
	try {
		const scope = path.join(root, "pilot"); fs.mkdirSync(scope);
		const legacy = path.join(root, "legacy.jsonl"), owner = newOwner();
		fs.writeFileSync(legacy, JSON.stringify({ type: "session", id: owner.instanceId }));
		acquire(legacy, owner, root);
		process.env.PI_SESSION_HISTORY_SCOPE = scope;
		assert(historyInScope(path.join(scope, "new.jsonl")));
		assert(!historyInScope(legacy));
		assert.throws(() => acquire(legacy, newOwner(), root), /outside pilot scope/);
		assert.throws(() => adopt(owner, newOwner(), root), /outside pilot scope/);
		assert.equal(inspect(legacy, root).instanceId, owner.instanceId);
		const link = path.join(scope, "alias.jsonl"); fs.symlinkSync(legacy, link);
		assert(!historyInScope(link));
		assert.throws(() => acquire(link, owner, root), /outside pilot scope/);
		const dangling = path.join(scope, "dangling.jsonl"); fs.symlinkSync(path.join(root, "future.jsonl"), dangling);
		assert(!historyInScope(dangling));
		assert.throws(() => acquire(dangling, owner, root), /outside pilot scope/);
		acquire(path.join(scope, "new.jsonl"), owner, root);
	} finally {
		if (previous === undefined) delete process.env.PI_SESSION_HISTORY_SCOPE;
		else process.env.PI_SESSION_HISTORY_SCOPE = previous;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
