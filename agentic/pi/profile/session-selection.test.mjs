import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { resolvePiPackage } from "./pi-runtime.mjs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { prepareOwnedLaunch } from "./session-selection.mjs";
import {
	acquire,
	reserveId,
	reserveNamespace,
	releaseNamespace,
	newOwner,
} from "../extensions/_session_ownership/ownership.mjs";
const pkg = resolvePiPackage();

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-selection-"));
	const sessions = path.join(root, "sessions");
	fs.mkdirSync(sessions);
	const env = { ...process.env, PI_CODING_AGENT_DIR: root, PI_SESSION_LOCK_ROOT: path.join(root, "ownership") };
	return { root, sessions, env, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
test("in-memory interactive owners retain runtime switching protection; print helpers opt out", async () => {
	const f = fixture();
	try {
		const interactive = await prepareOwnedLaunch(
			["--no-session", "--session-dir", f.sessions],
			pkg,
			f.env,
			f.root,
		);
		assert(interactive.env.PI_SESSION_OWNER);
		const helper = await prepareOwnedLaunch(
			["-p", "--no-session", "--no-extensions"],
			pkg,
			f.env,
			f.root,
		);
		assert.equal(helper.env.PI_SESSION_OWNER, undefined);
		await assert.rejects(
			prepareOwnedLaunch(["--no-session", "--mode", "rpc", "--no-extensions"], pkg, f.env, f.root),
			/ownership guards/,
		);
	} finally {
		f.close();
	}
});
test("no-history print helpers never reserve a namespace even with extensions enabled", async () => {
  const f = fixture();
  try {
    const helper = await prepareOwnedLaunch(["-p", "--no-session", "--session-dir", f.sessions], pkg, f.env, f.root);
    assert.equal(helper.env.PI_SESSION_OWNER, undefined);
    const owner = newOwner();
    reserveNamespace(owner, f.env.PI_SESSION_LOCK_ROOT);
    releaseNamespace(owner, f.env.PI_SESSION_LOCK_ROOT);
  } finally { f.close(); }
});

test("startup selectors precede -- and reserve explicit IDs before native allocation", async () => {
	const f = fixture();
	try {
		const id = randomUUID();
		const prepared = await prepareOwnedLaunch(
			["--session-id", id, "--session-dir", f.sessions, "--", "literal --session argument"],
			pkg,
			f.env,
			f.root,
		);
		assert(prepared.args.indexOf("--session-id") < prepared.args.indexOf("--"));
		const owner = JSON.parse(prepared.env.PI_SESSION_OWNER);
		releaseNamespace(owner, f.env.PI_SESSION_LOCK_ROOT);
		assert.throws(() => reserveId(id, newOwner(), f.env.PI_SESSION_LOCK_ROOT), /owned by/);
	} finally {
		f.close();
	}
});
test("native startup is read-only until ownership; duplicated native IDs remain exclusive", async () => {
	const f = fixture();
	try {
		const id = randomUUID();
		const content =
			JSON.stringify({
				type: "session",
				version: 3,
				id,
				timestamp: new Date().toISOString(),
				cwd: f.root,
			}) + "\n";
		const a = path.join(f.sessions, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
		const b = path.join(f.sessions, `copy_${id}.jsonl`);
		fs.writeFileSync(a, content);
		fs.writeFileSync(b, content);
		const prepared = await prepareOwnedLaunch(
			["--session", a, "--session-dir", f.sessions],
			pkg,
			f.env,
			f.root,
		);
		assert.equal(fs.readFileSync(a, "utf8"), content);
		releaseNamespace(JSON.parse(prepared.env.PI_SESSION_OWNER), f.env.PI_SESSION_LOCK_ROOT);
		assert.throws(() => acquire(b, newOwner(), f.env.PI_SESSION_LOCK_ROOT), /owned by/);
	} finally {
		f.close();
	}
});
test("contradictory selectors and saved-session extension opt-outs fail closed", async () => {
	const f = fixture();
	try {
		await assert.rejects(
			prepareOwnedLaunch(["--continue", "--session", "missing"], pkg, f.env, f.root),
			/Conflicting/,
		);
		await assert.rejects(
			prepareOwnedLaunch(["--no-extensions"], pkg, f.env, f.root),
			/ownership guards/,
		);
		await assert.rejects(
			prepareOwnedLaunch(["--no-session", "--session", "missing"], pkg, f.env, f.root),
			/cannot bypass/,
		);
	} finally {
		f.close();
	}
});

test("startup selectors never scan transcript bodies", async (t) => {
	const { SessionManager } = await import(pathToFileURL(path.join(pkg, "dist/core/session-manager.js")).href);
	t.mock.method(SessionManager, "list", () => { throw new Error("Transcript scan forbidden"); });
	t.mock.method(SessionManager, "listAll", () => { throw new Error("Transcript scan forbidden"); });
	for (const selector of ["fresh", "id", "path", "continue", "prefix"])  {
		const f = fixture();
		try {
			const id = randomUUID(), file = path.join(f.sessions, `saved_${id}.jsonl`);
			fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, cwd: f.root, timestamp: new Date().toISOString() }) + "\n");
			const args = selector === "id" ? ["--session-id", id] : selector === "path" ? ["--session", file] : selector === "continue" ? ["--continue"] : selector === "prefix" ? ["--session", id.slice(0, 8)] : [];
			const result = await prepareOwnedLaunch([...args, "--session-dir", f.sessions], pkg, f.env, f.root);
			assert(result.env.PI_SESSION_OWNER);
			if (selector !== "fresh") assert(result.args.some((arg) => arg.endsWith(".jsonl") && fs.realpathSync(arg) === fs.realpathSync(file)));
		} finally { f.close(); }
	}
});

test("SDK discovery survives npm-run project prefixes", () => {
	const f = fixture();
	try {
		const env = { ...process.env, npm_config_prefix: f.root };
		delete env.PI_CLI_PACKAGE;
		assert(fs.existsSync(path.join(resolvePiPackage(env), "package.json")));
	} finally {
		f.close();
	}
});

test("compatible locally updated Pi runtimes are accepted regardless of version", async () => {
	const f = fixture();
	try {
		const updated = path.join(f.root, "runtime");
		fs.mkdirSync(updated);
		fs.writeFileSync(path.join(updated, "package.json"), JSON.stringify({ version: "1.6.0", type: "module" }));
		fs.symlinkSync(path.join(pkg, "dist"), path.join(updated, "dist"));
		const result = await prepareOwnedLaunch(["--session-dir", f.sessions], updated, f.env, f.root);
		assert(result.env.PI_SESSION_OWNER);
	} finally {
		f.close();
	}
});

test("changed runtime contracts fail before ownership reservations", async () => {
	for (const changed of ["selectors", "format", "lookup"]) {
		const f = fixture();
		try {
			const runtime = path.join(f.root, "runtime");
			fs.mkdirSync(path.join(runtime, "dist/cli"), { recursive: true });
			fs.mkdirSync(path.join(runtime, "dist/core"));
			fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ version: "1.7.0", type: "module" }));
			const argsUrl = JSON.stringify(pathToFileURL(path.join(pkg, "dist/cli/args.js")).href);
			const sessionUrl = JSON.stringify(pathToFileURL(path.join(pkg, "dist/core/session-manager.js")).href);
			fs.writeFileSync(path.join(runtime, "dist/cli/args.js"), changed === "selectors" ? 'export const parseArgs = () => ({});' : `export * from ${argsUrl};`);
			fs.writeFileSync(path.join(runtime, "dist/core/session-manager.js"), `export * from ${sessionUrl};\n` + (changed === "format" ? 'export const CURRENT_SESSION_VERSION = 4;' : changed === "lookup" ? 'export const findMostRecentSession = () => undefined;' : ''));
			await assert.rejects(prepareOwnedLaunch([], runtime, f.env, f.root), /Pi 1\.7\.0.*ownership capabilities/);
			assert.equal(fs.existsSync(f.env.PI_SESSION_LOCK_ROOT), false);
		} finally { f.close(); }
	}
});

test("unsupported Pi runtimes fail with a capability error before native history access", async () => {
	const f = fixture();
	try {
		const unsupported = path.join(f.root, "runtime");
		fs.mkdirSync(unsupported);
		fs.writeFileSync(path.join(unsupported, "package.json"), JSON.stringify({ version: "99.0.0" }));
		await assert.rejects(
			prepareOwnedLaunch([], unsupported, f.env, f.root),
			/Pi 99\.0\.0.*ownership.*capabilit/i,
		);
	} finally {
		f.close();
	}
});
