import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { watcherShell } from "./watcher.ts";

async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 60; i++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.fail("watcher did not reconcile within six seconds");
}

function stop(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (child.exitCode !== null) { resolve(); return; }
		child.once("exit", () => resolve());
		child.kill("SIGTERM");
	});
}

test("watchers coordinate holds, recover resets, and preserve thermal cutoff", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-caffeinate-test-"));
	const pmset = path.join(dir, "pmset");
	const sudo = path.join(dir, "sudo");
	const battery = path.join(dir, "battery");
	const setting = path.join(dir, "setting");
	const temp = path.join(dir, "temperature");
	fs.writeFileSync(setting, "0\n");
	fs.writeFileSync(temp, "3000\n");
	fs.writeFileSync(pmset, `#!/bin/sh\nif [ "$1" = -g ]; then [ "$(/bin/cat '${setting}')" = 1 ] && echo 'SleepDisabled 1'; else echo "$3" > '${setting}'; fi\n`, { mode: 0o755 });
	fs.writeFileSync(sudo, "#!/bin/sh\nshift\nexec \"$@\"\n", { mode: 0o755 });
	fs.writeFileSync(battery, `#!/bin/sh\necho '"BatteryData" = {"TemperatureSamples"=99999}'\necho '"VirtualTemperature" = 3600'\necho '"Temperature" = '$(/bin/cat '${temp}')\n`, { mode: 0o755 });
	const owner = spawn("/bin/sleep", ["30"]);
	const watchers: ChildProcess[] = [];
	try {
		const start = (pid: number) => {
			const state = path.join(dir, `pi-caffeinate-${pid}.state`);
			const marker = path.join(dir, `pi-caffeinate-${pid}.hot`);
			fs.writeFileSync(state, "1");
			const watcher = spawn("/bin/sh", ["-c", watcherShell(pid, state, marker, { pmset, sudo, battery })], { stdio: "ignore" });
			watchers.push(watcher);
			return { state, marker, watcher };
		};
		const first = start(process.pid);
		await until(() => fs.readFileSync(setting, "utf8").trim() === "1");
		const second = start(owner.pid!);
		await until(() => fs.existsSync(path.join(dir, "pi-caffeinate.lock")));

		fs.writeFileSync(first.state, "0");
		await new Promise((resolve) => setTimeout(resolve, 1200));
		assert.equal(fs.readFileSync(setting, "utf8").trim(), "1", "first release must not cancel second hold");
		await stop(first.watcher);
		assert.equal(fs.readFileSync(setting, "utf8").trim(), "1", "first cleanup must not cancel second hold");

		fs.writeFileSync(setting, "0\n"); // external power-setting reset
		await until(() => fs.readFileSync(setting, "utf8").trim() === "1");
		fs.writeFileSync(temp, "3600\n");
		await until(() => fs.readFileSync(setting, "utf8").trim() === "0" && fs.existsSync(second.marker));
		fs.writeFileSync(temp, "3000\n");
		await until(() => fs.readFileSync(setting, "utf8").trim() === "1");

		fs.writeFileSync(second.state, "0");
		await until(() => fs.readFileSync(setting, "utf8").trim() === "0");
	} finally {
		await Promise.all(watchers.map(stop));
		owner.kill();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
