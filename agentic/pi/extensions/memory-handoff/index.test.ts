import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import register from "./index.ts";
import { runLibrarian } from "./runner.ts";

test("main registers only two handoff tools; delegated children register none", () => {
	const previous = process.env.PI_SUBAGENT_CHILD;
	const tools: string[] = [];
	const pi = { registerTool: (definition: { name: string }) => tools.push(definition.name) };
	try {
		delete process.env.PI_SUBAGENT_CHILD;
		register(pi as never);
		assert.deepEqual(tools, ["store_memory", "recall_memory"]);
		process.env.PI_SUBAGENT_CHILD = "1";
		register(pi as never);
		assert.deepEqual(tools, ["store_memory", "recall_memory"]);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous;
	}
});

test("handoff passes memory privately via a temporary file and restricts recall", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-handoff-test-"));
	const bin = path.join(dir, "bin");
	fs.mkdirSync(bin);
	const cli = path.join(bin, "pi");
	fs.writeFileSync(cli, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const file = args.at(-1).slice(1);
process.stdout.write(JSON.stringify({args, file, text:fs.readFileSync(file,"utf8"), mode:fs.statSync(file).mode & 0o777, recall:process.env.PI_MEMORY_RECALL_ONLY}));
`, { mode: 0o700 });
	try {
		const sensitive = "a remembered fact with spaces and 'quotes'";
		const stored = JSON.parse(await runLibrarian("store", sensitive, undefined, dir));
		assert.equal(stored.text, sensitive);
		assert.equal(stored.recall, undefined);
		assert.equal(stored.mode, 0o600);
		assert.ok(stored.args.includes("librarian") && stored.args.includes("-p") && stored.args.includes("--no-session"));
		assert.ok(!stored.args.some((arg: string) => arg.includes(sensitive)));
		assert.ok(!fs.existsSync(stored.file));
		const recalled = JSON.parse(await runLibrarian("recall", "What is stored?", undefined, dir));
		assert.equal(recalled.recall, "1");
		assert.match(recalled.args.join(" "), /Never change memory/);
		assert.ok(!fs.existsSync(recalled.file));
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
