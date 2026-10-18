import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { install, LABEL, plist } from "./install-cleaning.mjs";

test("hourly launch agent runs at load and logs inside the bundle", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-clean-agent-test-"));
	fs.mkdirSync(path.join(home, "memory"));
	const calls = [];
	try {
		const installed = install({ home, nodePath: "/node", execute: (_command, args) => {
			calls.push(args); return { status: args[0] === "print" ? 1 : 0, stderr: "" };
		} });
		assert.equal(path.basename(installed.config), `${LABEL}.plist`);
		const config = fs.readFileSync(installed.config, "utf8");
		assert.match(config, /<key>StartCalendarInterval<\/key>/);
		assert.match(config, /<key>Minute<\/key><integer>0<\/integer>/);
		assert.match(config, /<key>RunAtLoad<\/key><true\/>/);
		assert.ok(config.includes(path.join(home, "memory", "cleaning.log")));
		assert.deepEqual(calls.map((args) => args[0]), ["print", "bootstrap"]);
	} finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("installer escapes XML paths and unloads an old registration", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-clean-agent-test-"));
	fs.mkdirSync(path.join(home, "memory"));
	const calls = [];
	try {
		assert.match(plist({ nodePath: "/a&b", scriptPath: "/c<d", logPath: "/e\"f" }),
			/a&amp;b.*c&lt;d/s);
		install({ home, execute: (_command, args) => { calls.push(args[0]); return { status: 0, stderr: "" }; } });
		assert.deepEqual(calls, ["print", "bootout", "bootstrap"]);
	} finally { fs.rmSync(home, { recursive: true, force: true }); }
});
