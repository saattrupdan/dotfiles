/** Own the container and its temporary resources beyond the terminal owner's lifetime. */
import * as fs from "node:fs";
import { spawn, execFile } from "node:child_process";
import { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
const filename = fileURLToPath(import.meta.url);

/** Run a container with terminal stdio and a separate terminal-owner lifetime pipe. */
export async function runSandboxContainer(configuration) {
	let guardian, result, phase = "creating";
	const handlers = new Map();
	try {
		guardian = spawn(process.execPath, [filename, "--guardian", JSON.stringify(configuration)], {
			detached: true, stdio: ["inherit", "inherit", "inherit", "pipe", "ipc"],
		});
		const lifetime = guardian.stdio[3];
		lifetime.on("error", () => {});
		for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"]) {
			const handler = () => lifetime.end();
			handlers.set(signal, handler);
			process.on(signal, handler);
		}
		const resize = () => { if (guardian.connected) guardian.send({ type: "resize" }, () => {}); };
		handlers.set("SIGWINCH", resize);
		process.on("SIGWINCH", resize);
		await new Promise((resolve, reject) => {
			guardian.on("message", message => {
				if (message?.type === "sandbox-disposed") result = message;
				if (message?.type === "sandbox-phase") phase = message.phase;
			});
			guardian.once("error", reject);
			guardian.once("close", resolve);
		});
		if (!result?.removed) throw new Error(`Sandbox owner exited without confirming removal: ${configuration.name}`);
		return result.code;
	} catch (error) {
		// Let an orphaned create finish before absence can mean successful removal.
		if (guardian?.pid) await settleClients(guardian.pid, phase);
		await removeContainer(configuration);
		fs.rmSync(configuration.temporary, { recursive: true, force: true });
		throw error;
	} finally {
		for (const [signal, handler] of handlers) process.off(signal, handler);
		guardian?.stdio[3]?.destroy();
	}
}

async function supervise(configuration) {
	let client, phase = "creating", closing = false, escalation;
	const lifetime = new Socket({ fd: 3, readable: true, writable: false });
	const close = () => {
		closing = true;
		// Finish creation first: killing an unacknowledged create can race daemon registration.
		if (phase !== "attached" || !client || client.exitCode !== null || client.signalCode !== null) return;
		client.kill("SIGTERM");
		escalation ??= setTimeout(() => client.kill("SIGKILL"), 1000);
	};
	lifetime.on("end", close);
	lifetime.on("error", close);
	lifetime.resume();
	process.on("disconnect", close);
	process.on("message", message => {
		if (message?.type === "resize" && phase === "attached") client?.kill("SIGWINCH");
	});
	for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"]) process.on(signal, close);
	let code = 1, removed = false;
	try {
		// Separate creation from attachment so cleanup always knows when the name exists.
		client = spawn(configuration.container, ["create", ...configuration.args.slice(1)], { stdio: ["ignore", "ignore", "inherit"] });
		code = await exited(client);
		if (code === 0 && !closing) {
			// Publish acknowledgement before an attached client can outlive this owner.
			if (process.connected) await new Promise(resolve => process.send({ type: "sandbox-phase", phase: "attached" }, () => resolve()));
			if (!closing) {
				phase = "attached";
				client = spawn(configuration.container, ["start", "--attach", "--interactive", configuration.name], { stdio: "inherit" });
				code = await exited(client);
			}
		}
		if (closing) code = 130;
	} finally {
		clearTimeout(escalation);
		phase = "disposing";
		await removeContainer(configuration);
		removed = true;
		fs.rmSync(configuration.temporary, { recursive: true, force: true });
		if (process.connected) await new Promise(resolve => process.send({ type: "sandbox-disposed", removed, code }, () => resolve()));
		lifetime.destroy();
		if (process.connected) process.disconnect();
	}
	process.exitCode = code;
}

function exited(child) {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve(signal ? 130 : code ?? 1));
	});
}

async function settleClients(group, phase) {
	const deadline = Date.now() + 30000;
	const signal = value => { try { process.kill(-group, value); } catch (error) { if (error.code !== "ESRCH") throw error; } };
	if (phase === "attached") signal("SIGTERM");
	const escalate = Date.now() + 1000;
	while (Date.now() < deadline) {
		const { stdout } = await execute("/bin/ps", ["-axo", "pgid=,stat="], { timeout: 5000, maxBuffer: 1024 * 1024 });
		const live = stdout.trim().split("\n").some(line => {
			const [id, status] = line.trim().split(/\s+/);
			return Number(id) === group && !status.startsWith("Z");
		});
		if (!live) return;
		if (phase === "attached" && Date.now() >= escalate) signal("SIGKILL");
		await delay(50);
	}
	throw new Error(`Sandbox creation client has not finished; resources retained for process group ${group}`);
}

async function removeContainer({ container, name }) {
	for (let attempt = 0; attempt < 3; attempt++) {
		for (const args of [["stop", "--time", "1", name], ["delete", "--force", name]]) {
			try { await execute(container, args, { timeout: 10000, maxBuffer: 65536 }); } catch { /* --rm may already have removed it; inspect decides success. */ }
		}
		try {
			await execute(container, ["inspect", name], { timeout: 10000, maxBuffer: 65536 });
		} catch (error) {
			if (!error.killed && String(error.stderr).includes(`container not found: ${name}`)) return;
			if (attempt === 2) throw new Error(`Could not verify sandbox container removal: ${name}`);
		}
		await delay(200);
	}
	throw new Error(`Sandbox container still exists after cleanup: ${name}`);
}

if (process.argv[1] === filename && process.argv[2] === "--guardian") {
	try {
		await supervise(JSON.parse(process.argv[3]));
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
		if (process.connected) process.disconnect();
		process.exit(1);
	}
}
