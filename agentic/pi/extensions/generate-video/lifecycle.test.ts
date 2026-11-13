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
		docker: `if [[ $1 == inspect && \${RACING_START:-0} == 1 && ! -f $HOME/first-inspect ]]; then
  touch "$HOME/first-inspect"; exit 1
fi
case $1 in
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

test("remote lease leaves ready servers to their built-in idle timer on release and EOF", async () => {
	for (const action of ["release", ""]) {
		const state = await fixture();
		try {
			const result = await state.run(action);
			assert.equal(result.code, 0, result.stderr);
			assert.match(result.stdout, /READY/);
			assert.doesNotMatch(result.stdout, /STOPPED/);
			assert.equal(await readFile(path.join(state.home, "container"), "utf8"), "original\n");
			await assert.rejects(readFile(path.join(state.home, "stopped")));
		} finally { await state.close(); }
	}
});

test("remote lease does not stop an adopted server when loading is cancelled", async () => {
	const state = await fixture();
	try {
		const result = await state.run("release", { LOADING: "1" });
		assert.equal(result.code, 0);
		assert.doesNotMatch(result.stdout, /READY|STOPPED/);
		assert.equal(await readFile(path.join(state.home, "container"), "utf8"), "original\n");
	} finally { await state.close(); }
});

test("a racing external startup is never mistaken for Pi-owned cleanup", async () => {
	const state = await fixture();
	try {
		await writeFile(path.join(state.home, "model-servers/minimax-h3/start.sh"), "#!/bin/bash\nexit 1\n");
		const result = await state.run("release", { LOADING: "1", RACING_START: "1" });
		assert.doesNotMatch(result.stdout, /STOPPED/);
		assert.equal(await readFile(path.join(state.home, "container"), "utf8"), "original\n");
		await assert.rejects(readFile(path.join(state.home, "stopped")));
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

test("remote lease reports preservation and contention without stopping a ready server", async () => {
	for (const [action, env, pattern, code] of [
		["preserve", {}, /submission outcome is unknown/, 0],
		["release", { LOCKED: "1" }, /Another Pi session/, 1],
	] as const) {
		const state = await fixture();
		try {
			const result = await state.run(action, env);
			assert.equal(result.code, code);
			assert.match(result.stdout + result.stderr, pattern);
			assert.equal(await readFile(path.join(state.home, "container"), "utf8"), "original\n");
		} finally { await state.close(); }
	}
});


test("SSH lease returns the failed launcher's memory diagnostic", async () => {
    const state = await fixture();
    const savedHome = process.env.HOME, savedPath = process.env.PATH;
    try {
        await rm(path.join(state.home, "container"));
        await writeFile(path.join(state.home, "bin/docker"), '#!/bin/bash\nsleep 0.2\nexit 1\n', { mode: 0o755 });
        await writeFile(path.join(state.home, "model-servers/minimax-h3/start.sh"),
            '#!/bin/bash\necho "Video model needs 85 GiB available; only 54.0 GiB available" >&2\nexit 1\n');
        await writeFile(path.join(state.home, "bin/ssh"), `#!/bin/bash\nexec /bin/bash '${script}'\n`, { mode: 0o755 });
        process.env.HOME = state.home;
        process.env.PATH = `${state.home}/bin:${savedPath}`;
        await assert.rejects(acquireSparkie(AbortSignal.timeout(5000)),
            /MiniMax-H3 startup failed:.*\n.*needs 85 GiB available; only 54.0 GiB available/);
    } finally {
        process.env.HOME = savedHome;
        process.env.PATH = savedPath;
        await state.close();
    }
});
