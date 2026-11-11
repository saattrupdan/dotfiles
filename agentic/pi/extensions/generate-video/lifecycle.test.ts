import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { acquireSparkie } from "./lifecycle.ts";

const script = fileURLToPath(new URL("./sparkie-lease.sh", import.meta.url));

async function fixture() {
	const home = await mkdtemp(path.join(os.tmpdir(), "pi-h3-lease-test-"));
	const bin = path.join(home, "bin");
	await mkdir(bin);
	await mkdir(path.join(home, "model-servers/minimax-h3"), { recursive: true });
	await writeFile(path.join(home, "container"), "original\n");
	await writeFile(path.join(home, "jobs"), JSON.stringify({ has_more: false, data: [{ status: "completed" }] }));
	const commands = {
		flock: '[[ ${LOCKED:-0} != 1 ]]',
		docker: `case $1 in
inspect)
  [[ -f $HOME/container ]] || exit 1
  if [[ $* == *Config.Image* ]]; then echo minimax-h3-lora:test
  else cat "$HOME/container"; fi ;;
stop)
  [[ \${STOP_FAILS:-0} != 1 ]] || exit 1
  echo "$*" > "$HOME/stopped"
  rm "$HOME/container" ;;
esac`,
		curl: `if [[ $* == *health* ]]; then [[ \${LOADING:-0} != 1 ]]; exit $?; fi
if [[ \${INSPECT_FAILS:-0} == 1 ]]; then exit 1; fi
if [[ \${REPLACED:-0} == 1 ]]; then echo replacement > "$HOME/container"; fi
cat "$HOME/jobs"`,
	};
	for (const [name, body] of Object.entries(commands)) {
		await writeFile(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
	}
	return {
		home,
		async run(action = "release", extra: Record<string, string> = {}) {
			return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
				const child = spawn("/bin/bash", [script], {
					env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ...extra },
				});
				let stdout = "", stderr = "";
				child.stdout.on("data", (data) => { stdout += String(data); });
				child.stderr.on("data", (data) => { stderr += String(data); });
				child.on("error", reject);
				child.on("close", (code) => resolve({ code, stdout, stderr }));
				child.stdin.end(action ? `${action}\n` : "");
			});
		},
		close: () => rm(home, { recursive: true, force: true }),
	};
}

test("remote lease stops the captured container on release and EOF", async () => {
	for (const action of ["release", ""]) {
		const state = await fixture();
		try {
			const result = await state.run(action);
			assert.equal(result.code, 0, result.stderr);
			assert.match(result.stdout, /READY\nSTOPPED/);
			assert.equal(await readFile(path.join(state.home, "stopped"), "utf8"), "stop --time 20 original\n");
		} finally { await state.close(); }
	}
});

test("remote lease preserves active, unknown, truncated and malformed job lists", async () => {
	for (const jobs of [
		{ has_more: false, data: [{ status: "in_progress" }] },
		{ has_more: false, data: [{ status: "queued" }] },
		{ has_more: false, data: [{ status: "unknown" }] },
		{ has_more: true, data: [] }, {}, "malformed",
	]) {
		const state = await fixture();
		try {
			await writeFile(path.join(state.home, "jobs"), typeof jobs === "string" ? jobs : JSON.stringify(jobs));
			const result = await state.run();
			assert.equal(result.code, 0);
			assert.match(result.stdout, /WARNING/);
			assert.equal(await readFile(path.join(state.home, "container"), "utf8"), "original\n");
		} finally { await state.close(); }
	}
});

test("remote lease checks jobs and stops an idle server when loading is cancelled", async () => {
	const state = await fixture();
	try {
		const result = await state.run("release", { LOADING: "1" });
		assert.equal(result.code, 0);
		assert.doesNotMatch(result.stdout, /READY/);
		assert.match(result.stdout, /STOPPED/);
	} finally { await state.close(); }
});

test("SSH lease releases once and reports shutdown warnings", async () => {
	const state = await fixture();
	const savedHome = process.env.HOME, savedPath = process.env.PATH;
	try {
		await writeFile(path.join(state.home, "bin/ssh"), '#!/bin/bash\necho READY\nread -r action\necho "$action" > "$HOME/released"\necho "WARNING server left running"\n', { mode: 0o755 });
		process.env.HOME = state.home;
		process.env.PATH = `${state.home}/bin:${savedPath}`;
		const controller = new AbortController();
		const release = await acquireSparkie(controller.signal);
		controller.abort();
		const first = release(true);
		const second = release(false);
		assert.deepEqual(await first, ["server left running"]);
		assert.deepEqual(await second, ["server left running"]);
		assert.equal(await readFile(path.join(state.home, "released"), "utf8"), "preserve\n");
	} finally {
		process.env.HOME = savedHome;
		process.env.PATH = savedPath;
		await state.close();
	}
});

test("SSH lease cancellation during startup waits for remote cleanup", async () => {
	const state = await fixture();
	const savedHome = process.env.HOME, savedPath = process.env.PATH;
	try {
		await writeFile(path.join(state.home, "bin/ssh"), '#!/bin/bash\nread -r action\necho "$action" > "$HOME/released"\n', { mode: 0o755 });
		process.env.HOME = state.home;
		process.env.PATH = `${state.home}/bin:${savedPath}`;
		await assert.rejects(acquireSparkie(AbortSignal.timeout(50)));
		assert.equal(await readFile(path.join(state.home, "released"), "utf8"), "release\n");
	} finally {
		process.env.HOME = savedHome;
		process.env.PATH = savedPath;
		await state.close();
	}
});

test("remote lease reports preservation, inspection failure, stop failure and contention", async () => {
	for (const [action, env, pattern, code] of [
		["preserve", {}, /submission outcome is unknown/, 0],
		["release", { INSPECT_FAILS: "1" }, /Cannot inspect/, 0],
		["release", { STOP_FAILS: "1" }, /Failed to stop/, 0],
		["release", { LOCKED: "1" }, /Another Pi session/, 1],
		["release", { REPLACED: "1" }, /container changed/, 0],
	] as const) {
		const state = await fixture();
		try {
			const result = await state.run(action, env);
			assert.equal(result.code, code);
			assert.match(result.stdout + result.stderr, pattern);
			assert.equal(await readFile(path.join(state.home, "container"), "utf8"), "REPLACED" in env ? "replacement\n" : "original\n");
		} finally { await state.close(); }
	}
});
