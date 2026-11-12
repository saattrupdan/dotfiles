import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerPython from "./index.ts";
import { runPythonCode, type PythonInput, type PythonResult } from "./runner.ts";
import { toolPresentation } from "../_tool-display/presentation.ts";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
const outputs: string[] = [];
const run = async (input: PythonInput, cwd = os.tmpdir(), signal?: AbortSignal): Promise<PythonResult> => {
	const result = await runPythonCode(input, cwd, signal);
	outputs.push(path.dirname(result.outputPath));
	return result;
};

function tool(): Tool {
	let registered!: Tool;
	registerPython({ registerTool: (value: Tool) => { registered = value; } } as ExtensionAPI);
	return registered;
}

function render(value: { render(width: number): string[] }): string {
	return value.render(200).map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");
}

const multiline = `import json
text = r"""first line
'quotes', "double quotes", \\backslash
$HOME $(touch should-not-exist) \u0060shell\u0060
PY\nEOF
æøå 🐍"""
values = []
for number in range(3):
    values.append(number)
print(json.dumps({"text": text, "values": values}, ensure_ascii=False))
`;

test("multiline source preserves indentation, Unicode, quotes and shell syntax", async () => {
	const result = await run({ code: multiline });
	assert.equal(result.exitCode, 0, result.output);
	const parsed = JSON.parse(result.output.trim());
	assert.deepEqual(parsed.values, [0, 1, 2]);
	assert.match(parsed.text, /æøå 🐍/);
	assert.match(parsed.text, /\$HOME \$\(touch should-not-exist\)/);
	assert.match(parsed.text, /PY\nEOF/);
	assert.match(parsed.text, /\\backslash/);
});

test("source larger than argv limits and CRLF source are passed through stdin", async () => {
	const code = '# padding\n'.repeat(30000) + 'for value in ["hello"]:\r\n    print(value)\r\n';
	const result = await run({ code });
	assert.equal(result.exitCode, 0, result.output);
	assert.equal(result.output, "hello\n");
});

test("uses requested cwd and can import a module in the project directory", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-python-cwd-"));
	try {
		await writeFile(path.join(cwd, "local_module.py"), 'MESSAGE = "module loaded"\n');
		const result = await run({ code: "import local_module, os\nprint(local_module.MESSAGE)\nprint(os.getcwd())", cwd }, os.tmpdir());
		assert.equal(result.exitCode, 0, result.output);
		assert.match(result.output, /module loaded/);
		assert.ok(result.output.includes(cwd));
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("captures stderr, exceptions, exit codes and empty successful output", async () => {
	const result = await run({ code: 'import sys\nprint("stderr text", file=sys.stderr)\nraise ValueError("broken")' });
	assert.equal(result.exitCode, 1);
	assert.match(result.output, /stderr text/);
	assert.match(result.output, /ValueError: broken/);
	assert.equal((await run({ code: "pass" })).output, "");
	assert.equal((await run({ code: "raise SystemExit(7)" })).exitCode, 7);
});

test("caps returned bytes and lines while preserving full output in a private file", async () => {
	for (const code of ['print("x" * 80000)', 'print("line\\n" * 3000)']) {
		const result = await run({ code });
		assert.equal(result.exitCode, 0);
		assert.equal(result.truncated, true);
		assert.ok(Buffer.byteLength(result.output) <= 50 * 1024);
		assert.ok(result.output.split("\n").length <= 2000);
		assert.ok((await readFile(result.outputPath, "utf8")).length > result.output.length);
	}
});

test("rejects invalid aliases, options and timeouts before launching", async () => {
	for (const input of [
		{ code: "" }, { ssh_alias: "-oProxyCommand=bad" }, { ssh_alias: "alias;bad" },
		{ ssh_alias: "alias\nother" }, { python: "-c" }, { timeout: -1 }, { timeout: NaN }, { timeout: 86401 },
	]) await assert.rejects(run({ code: "pass", ...input }));
	await assert.rejects(run({ code: "pass" }, os.tmpdir(), AbortSignal.abort()), /cancelled/);
});

test("reports a missing interpreter as an error", async () => {
	const result = await run({ code: "pass", python: "/missing/python-executable" });
	assert.notEqual(result.exitCode, 0);
	assert.ok(result.output.length > 0);
});

test("timeouts and cancellation stop the Python process and its descendants", async () => {
	for (const abort of [false, true]) {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-python-stop-"));
		const controller = new AbortController();
		const pidPath = path.join(cwd, "pids");
		const promise = run({ code: `import os, subprocess, time
from pathlib import Path
child = subprocess.Popen(["sleep", "60"])
Path(${JSON.stringify(pidPath)}).write_text(f"{os.getpid()} {child.pid}")
while True:
    time.sleep(1)
`, timeout: abort ? 30 : 2 }, os.tmpdir(), controller.signal);
		try {
			let pids: number[] = [];
			for (let count = 0; count < 100; count++) {
				try { pids = (await readFile(pidPath, "utf8")).split(" ").map(Number); break; }
				catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
			}
			assert.equal(pids.length, 2, "Python should start before cancellation");
			if (abort) controller.abort();
			const result = await promise;
			assert.notEqual(result.exitCode, 0);
			assert.match(result.output, abort ? /cancelled/ : /timed out/);
			await new Promise((resolve) => setTimeout(resolve, 100));
			for (const pid of pids) assert.throws(() => process.kill(pid, 0), /ESRCH/);
		} finally { controller.abort(); await promise; await rm(cwd, { recursive: true, force: true }); }
	}
});

test("SSH transport quotes paths and keeps arbitrary multiline source off the command line", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-python-ssh-'quoted-"));
	const previous = process.env.PATH;
	const previousRecord = process.env.PI_PYTHON_TEST_SSH;
	try {
		await writeFile(path.join(cwd, "ssh"), `#!/bin/sh
printf '%s\\n' "$@" > "$PI_PYTHON_TEST_SSH"
for last do :; done
exec /bin/sh -c "$last"
`, { mode: 0o700 });
		process.env.PATH = `${cwd}${path.delimiter}${previous}`;
		process.env.PI_PYTHON_TEST_SSH = path.join(cwd, "arguments");
		const result = await run({ code: multiline, ssh_alias: "test-alias", cwd });
		assert.equal(result.exitCode, 0, result.output);
		assert.deepEqual(JSON.parse(result.output).values, [0, 1, 2]);
		const args = await readFile(process.env.PI_PYTHON_TEST_SSH, "utf8");
		assert.match(args, /BatchMode=yes/);
		assert.match(args, /--\ntest-alias\n/);
		assert.ok(!args.includes(multiline));
		assert.ok(!args.includes("touch should-not-exist"));
		const controller = new AbortController();
		const marker = path.join(cwd, "pid");
		const pending = run({ code: `import os, time\nfrom pathlib import Path\nPath(${JSON.stringify(marker)}).write_text(str(os.getpid()))\ntime.sleep(60)`, ssh_alias: "test-alias" }, os.tmpdir(), controller.signal);
		for (let count = 0; count < 100; count++) {
			try { await readFile(marker); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
		}
		controller.abort();
		assert.match((await pending).output, /cancelled/);
		const pid = Number(await readFile(marker, "utf8"));
		assert.throws(() => process.kill(pid, 0), /ESRCH/);
	} finally {
		process.env.PATH = previous;
		if (previousRecord === undefined) delete process.env.PI_PYTHON_TEST_SSH;
		else process.env.PI_PYTHON_TEST_SSH = previousRecord;
		await rm(cwd, { recursive: true, force: true });
	}
});

test("tool requires a single-line description of one to five words", () => {
	const schema = tool().parameters;
	assert.ok(schema.required?.includes("description"));
	const description = schema.properties.description;
	assert.equal(description.type, "string");
	const pattern = new RegExp(description.pattern);
	for (const value of ["Checking", "Checking the API validation", "One two three four five", "Tjekker æøå 🐍"])
		assert.ok(pattern.test(value), value);
	for (const value of ["", " ", "One two three four five six", "Checking\nthe API", "Checking\rthe API", "Checking\tthe API", "Checking\x1bthe API"])
		assert.ok(!pattern.test(value), JSON.stringify(value));
});

test("tool emits running state, preserves arguments when expanded and reports failures", async () => {
	const registered = tool();
	const updates: unknown[] = [];
	const result = await registered.execute("test", { description: "Checking the API validation", code: "print('ready')" }, undefined,
		(update) => updates.push(update), { cwd: os.tmpdir() } as never);
	outputs.push(path.dirname((result.details as PythonResult).outputPath));
	assert.equal(result.isError, false);
	assert.equal(updates.length, 1);
	assert.match(JSON.stringify(result.content), /ready/);
	const error = await registered.execute("test", { description: "Checking empty code", code: "" }, undefined, undefined, { cwd: os.tmpdir() } as never);
	assert.equal(error.isError, true);
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const args = { description: "Checking the API validation", code: multiline, ssh_alias: "server" };
	for (const expanded of [false, true]) {
		const call = render(registered.renderCall!(args, theme as never, { expanded } as never));
		assert.equal(call.split("\n")[0], "run_python_code Checking the API validation");
		assert.equal(call.includes(multiline.trimEnd()), expanded);
		if (expanded) assert.ok(call.includes("ssh_alias: server"));
	}
	for (const args of [{}, { code: multiline }, { description: "" }]) {
		for (const expanded of [false, true])
			assert.equal(render(registered.renderCall!(args, theme as never, { expanded } as never)).split("\n")[0], "run_python_code");
	}
	for (const [isPartial, isError, expected] of [
		[true, false, "⋯ Python code running"], [false, false, "✓ Python code executed"], [false, true, "✗ Python code failed"],
	] as const) {
		assert.equal(render(registered.renderResult!(result, { expanded: false, isPartial }, theme as never, { isError } as never)), expected);
	}
	assert.match(render(registered.renderResult!(result, { expanded: true, isPartial: false }, theme as never, {} as never)), /ready/);
});

test("native replay uses the same compact Python display for Remote and history", () => {
	const result = { content: [{ type: "text", text: "private output" }] };
	for (const [value, expected] of [[undefined, "⋯ Python code running"], [result, "✓ Python code executed"], [{ ...result, isError: true }, "✗ Python code failed"]] as const) {
		const display = toolPresentation("run_python_code", { description: "Checking the API validation", code: multiline }, value, "python-replay", os.tmpdir());
		assert.ok(display.includes("run_python_code Checking the API validation"), display);
		assert.ok(display.includes(expected), display);
		assert.ok(!display.includes("private output"));
		assert.ok(!display.includes(multiline));
	}
});

test.after(async () => {
	for (const directory of outputs) await rm(directory, { recursive: true, force: true });
});
