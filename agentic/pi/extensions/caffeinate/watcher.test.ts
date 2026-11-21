import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { watcherMessage, watcherShell } from "./watcher.ts";

async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 60; i++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.fail("watcher did not reconcile within six seconds");
}

function stop(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
		child.once("exit", () => resolve());
		child.kill("SIGTERM");
	});
}

function fixture(t: TestContext) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-caffeinate-test-"));
	const file = (name: string) => path.join(dir, name);
	const write = (name: string, value: string) => fs.writeFileSync(file(name), value);
	const read = (name: string) => {
		try { return fs.readFileSync(file(name), "utf8").trim(); } catch { return ""; }
	};
	const script = (name: string, source: string) => {
		fs.writeFileSync(file(name), `#!/bin/sh\n${source}\n`, { mode: 0o755 });
		return file(name);
	};
	write("setting", "0");
	write("temperature", "3000");
	write("lid-state", "No");
	write("log", "");
	const pmset = script("pmset", `
case "$1" in
  -g)
    if [ "$2" = custom ]; then printf 'Battery Power:\\n sleep 1\\nAC Power:\\n sleep 1\\n'
    else printf 'System-wide power settings:\\n SleepDisabled %s\\n' "$(/bin/cat '${file("setting")}')"; fi ;;
  -a)
    if [ -f '${file("deny-setting")}' ]; then echo setting-denied >> '${file("log")}'; exit 1; fi
    echo "$3" > '${file("setting")}' ;;
  sleepnow)
    if [ "$(/bin/cat '${file("setting")}')" = 1 ]; then echo sleep-denied-disabled >> '${file("log")}'; exit 71; fi
    if [ -f '${file("deny-sleep")}' ]; then echo sleep-denied >> '${file("log")}'; exit 1; fi
    echo sleep-requested >> '${file("log")}' ;;
  *) exit 90 ;;
esac`);
	const sudo = script("sudo", `
[ "$1" = -n ] || exit 91
shift
[ "$1" = '${pmset}' ] || exit 92
exec "$@"`);
	const battery = script("battery", `
[ "$(/bin/cat '${file("temperature")}')" != failed ] || exit 1
echo '"BatteryData" = {"TemperatureSamples"=99999}'
echo '"VirtualTemperature" = 9900'
printf '"Temperature" = %s\\n' "$(/bin/cat '${file("temperature")}')"`);
	const lid = script("lid", `
[ "$(/bin/cat '${file("lid-state")}')" != failed ] || exit 1
echo '  |   "VirtualAppleClamshellState" = Yes'
printf '  |   "AppleClamshellState" = %s\\n' "$(/bin/cat '${file("lid-state")}')"`);
	const watchers: ChildProcess[] = [];
	const owners: ChildProcess[] = [];
	t.after(async () => {
		await Promise.all(watchers.map(stop));
		await Promise.all(owners.map(stop));
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const start = (active = true) => {
		const owner = spawn("/bin/sleep", ["120"]);
		owners.push(owner);
		const state = file(`pi-caffeinate-${owner.pid!}.state`);
		const marker = file(`pi-caffeinate-${owner.pid!}.hot`);
		fs.writeFileSync(state, active ? "1" : "0");
		const commands = { pmset, sudo, battery, lid };
		const watcher = spawn("/bin/sh", ["-c", watcherShell(owner.pid!, state, marker, commands)], { stdio: "ignore" });
		watchers.push(watcher);
		return { owner, state, marker, watcher };
	};
	return { dir, file, write, read, start };
}

test("thermal cutoff explicitly requests sleep for a hot closed laptop", async (t) => {
	const f = fixture(t);
	f.write("lid-state", "Yes");
	f.write("temperature", "3500");
	f.start();
	await until(() => f.read("log").includes("sleep-requested"));
	assert.equal(f.read("setting"), "0");
});

test("watchers coordinate holds and recover external power-setting resets", async (t) => {
	const f = fixture(t);
	const first = f.start();
	await until(() => f.read("setting") === "1");
	const second = f.start();
	await until(() => fs.existsSync(f.file("pi-caffeinate.lock")));
	fs.writeFileSync(first.state, "0");
	await new Promise((resolve) => setTimeout(resolve, 1200));
	assert.equal(f.read("setting"), "1", "first release must not cancel second hold");
	await stop(first.watcher);
	assert.equal(f.read("setting"), "1", "cleanup must preserve the other hold");
	f.write("setting", "0");
	await until(() => f.read("setting") === "1");
	f.write("temperature", "3500");
	await until(() => f.read("setting") === "0" && fs.existsSync(second.marker));
	assert.equal(f.read("log"), "", "an open lid must not authorize forced sleep");
	f.write("temperature", "3000");
	await until(() => f.read("setting") === "1");
	fs.writeFileSync(second.state, "0");
	await until(() => f.read("setting") === "0");
});

test("3499 is below the cutoff and does not request sleep", async (t) => {
	const f = fixture(t);
	f.write("lid-state", "Yes");
	f.write("temperature", "3499");
	f.start();
	await until(() => f.read("setting") === "1");
	assert.equal(f.read("log"), "");
});

test("thermal inhibition survives cooler readings and replacement watchers until the lid opens", async (t) => {
	const f = fixture(t);
	f.write("lid-state", "Yes");
	f.write("temperature", "3600");
	const first = f.start();
	const second = f.start();
	await until(() => f.read("log").includes("sleep-requested") && fs.existsSync(first.marker) && fs.existsSync(second.marker));
	assert.equal(f.read("log").split("\n").filter((line) => line === "sleep-requested").length, 1, "concurrent watchers must share the sleep request");
	f.write("temperature", "3000");
	await stop(first.watcher);
	await stop(first.owner);
	const replacement = f.start();
	await until(() => fs.existsSync(replacement.marker));
	await new Promise((resolve) => setTimeout(resolve, 1200));
	assert.equal(f.read("setting"), "0", "cooling in a closed bag must not restore holds");
	f.write("lid-state", "No");
	await until(() => f.read("setting") === "1");
	f.write("temperature", "3500");
	f.write("lid-state", "Yes");
	await until(() => f.read("setting") === "0");
});

test("failed sleep requests are reported and retried without restoring holds", async (t) => {
	const f = fixture(t);
	f.write("lid-state", "Yes");
	f.write("temperature", "3500");
	f.write("deny-sleep", "1");
	const session = f.start();
	await until(() => f.read("log").includes("sleep-denied"));
	await until(() => f.read(path.basename(session.marker)).includes("sleep-failed"));
	assert.equal(f.read("setting"), "0");
	fs.rmSync(f.file("deny-sleep"));
	await until(() => f.read("log").includes("sleep-requested"));
});

test("a failed global reset remains visible and retries before sleep succeeds", async (t) => {
	const f = fixture(t);
	f.write("lid-state", "Yes");
	f.write("temperature", "3500");
	f.write("setting", "1");
	f.write("deny-setting", "1");
	const session = f.start();
	await until(() => f.read("log").includes("sleep-denied-disabled"));
	await until(() => f.read(path.basename(session.marker)).includes("setting-failed"));
	assert.doesNotMatch(f.read("log"), /sleep-requested/);
	fs.rmSync(f.file("deny-setting"));
	await until(() => f.read("setting") === "0");
	await until(() => f.read("log").includes("sleep-requested"));
});

for (const temperature of ["", "nonsense", "failed"]) {
	test(`unavailable battery reading (${JSON.stringify(temperature)}) cannot hold a closed laptop awake`, async (t) => {
		const f = fixture(t);
		f.write("lid-state", "Yes");
		f.write("temperature", temperature);
		f.start();
		await until(() => f.read("log").includes("sleep-requested"));
		assert.equal(f.read("setting"), "0");
	});
}

for (const lid of ["", "Unknown", "failed"]) {
	test(`unknown lid reading (${JSON.stringify(lid)}) inhibits holds without forcing sleep`, async (t) => {
		const f = fixture(t);
		f.write("lid-state", lid);
		f.write("setting", "1");
		const session = f.start();
		await until(() => f.read("setting") === "0" && fs.existsSync(session.marker));
		assert.equal(f.read("log"), "");
	});
}


test("idle sessions and dead state files do not authorize thermal sleep", async (t) => {
	const f = fixture(t);
	f.write("lid-state", "Yes");
	f.write("temperature", "3500");
	fs.writeFileSync(f.file("pi-caffeinate-2147483647.state"), "1");
	f.start(false);
	await until(() => fs.existsSync(f.file("pi-caffeinate.lock")));
	await new Promise((resolve) => setTimeout(resolve, 1200));
	assert.equal(f.read("setting"), "0");
	assert.equal(f.read("log"), "");
});

test("unreadable battery with open lid releases holds without forcing sleep", async (t) => {
	const f = fixture(t);
	f.write("temperature", "failed");
	f.write("setting", "1");
	const session = f.start();
	await until(() => f.read("setting") === "0" && fs.existsSync(session.marker));
	assert.equal(f.read("log"), "");
	assert.match(f.read(path.basename(session.marker)), /temperature-unavailable/);
});

test("thermal notices distinguish requests, failures, and recovery", () => {
	assert.match(watcherMessage("sleep-requested\n"), /requested macOS sleep/);
	assert.doesNotMatch(watcherMessage("sleep-requested"), /is asleep|has slept|will continue/);
	assert.match(watcherMessage("sleep-failed"), /retry/);
	assert.match(watcherMessage("setting-failed"), /retry/);
	assert.match(watcherMessage("hot-open"), /open laptop will not be forced/);
	assert.match(watcherMessage("temperature-unavailable"), /could not be read/);
	assert.match(watcherMessage("lid-unavailable"), /confirmed closed lid/);
	assert.match(watcherMessage("resumed"), /available again/);
	assert.match(watcherMessage("unrecognized"), /put it to sleep manually/);
});


test("global sleep inhibition is cleared before requesting sleep", async (t) => {
	const f = fixture(t);
	f.write("lid-state", "Yes");
	f.write("temperature", "3500");
	f.write("setting", "1");
	f.start();
	await until(() => f.read("log").includes("sleep-requested"));
	assert.equal(f.read("setting"), "0");
	assert.doesNotMatch(f.read("log"), /sleep-denied-disabled/);
});
