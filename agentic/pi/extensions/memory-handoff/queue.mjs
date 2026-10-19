import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const defaultRoot = () => path.join(os.homedir(), "memory");
export const states = ["pending", "running", "failed", "done"];
const ID = /^\d{13}-\d+-[0-9a-f]{12}$/;
const MAX_TEXT = 128_000;

export function queueRoot(root = defaultRoot()) {
	if (!fs.statSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) {
		throw new Error(`Memory bundle must be a real directory: ${root}`);
	}
	const directory = path.join(root, "requests");
	for (const folder of [directory, ...states.map((state) => path.join(directory, state))]) {
		const info = fs.lstatSync(folder, { throwIfNoEntry: false });
		if (info && !info.isDirectory()) throw new Error(`Memory queue path must be a real directory: ${folder}`);
		if (!info) fs.mkdirSync(folder, { mode: 0o700 });
	}
	fs.chmodSync(directory, 0o700);
	return directory;
}

export function jobFile(root, state, id) {
	if (!states.includes(state) || !ID.test(id)) throw new Error("Invalid memory job ID or state");
	return path.join(queueRoot(root), state, `${id}.json`);
}

export function atomicJob(file, job) {
	const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		fs.writeFileSync(temp, JSON.stringify(job), { flag: "wx", mode: 0o600 });
		const handle = fs.openSync(temp, "r");
		try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
		fs.renameSync(temp, file);
		try {
			const directory = fs.openSync(path.dirname(file), "r");
			try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
		} catch (error) {
			if (!["EINVAL", "ENOTSUP"].includes(error.code)) throw error;
		}
	} finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

export function enqueue(text, root = defaultRoot()) {
	if (!text.trim()) throw new Error("Memory text must not be empty");
	if (Buffer.byteLength(text) > MAX_TEXT) throw new Error("Memory text exceeds the 128 KB input limit");
	const id = `${Date.now()}-${process.pid}-${randomBytes(6).toString("hex")}`;
	atomicJob(jobFile(root, "pending", id), { id, text, createdAt: new Date().toISOString(), attempts: 0 });
	return id;
}

export function list(root = defaultRoot(), state = "pending") {
	if (!states.includes(state)) throw new Error("Invalid memory job state");
	return fs.readdirSync(path.join(queueRoot(root), state)).filter((name) => ID.test(name.replace(/\.json$/, "")) && name.endsWith(".json"))
		.map((name) => name.slice(0, -5)).sort();
}

export function readJob(root, state, id) {
	return JSON.parse(fs.readFileSync(jobFile(root, state, id), "utf8"));
}

export function counts(root = defaultRoot()) {
	return Object.fromEntries(states.map((state) => [state, list(root, state).length]));
}

// Serialize review decisions and manual retries across processes. A stale lock is recoverable.
export function withTransitionLock(root, action) {
	const lock = path.join(queueRoot(root), ".transition.lock");
	const acquire = () => {
		try { fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 }); }
		catch (error) {
			if (error.code !== "EEXIST") throw error;
			const owner = Number(fs.readFileSync(lock, "utf8"));
			try { if (owner > 0) { process.kill(owner, 0); throw new Error("Memory job transition in progress", { cause: error }); } }
			catch (check) { if (check.code !== "ESRCH") throw check; }
			fs.unlinkSync(lock);
			acquire();
		}
	};
	acquire();
	try { return action(); }
	finally { if (fs.readFileSync(lock, "utf8") === String(process.pid)) fs.unlinkSync(lock); }
}

export function assertUnchanged(current, reviewed) {
	if (reviewed && (current.id !== reviewed.id || current.attempts !== reviewed.attempts ||
		current.failedAt !== reviewed.failedAt || current.retriedAt !== reviewed.retriedAt || current.text !== reviewed.text)) {
		throw new Error("Failed job changed during review; inspect it again next run");
	}
}

export function retry(root, id, confirmed = false, reviewed) {
	return withTransitionLock(root, () => {
		const job = readJob(root, "failed", id);
		assertUnchanged(job, reviewed);
		if (job.unknownOutcome && !confirmed) throw new Error("Outcome unknown: verify the concept first, then retry with --confirmed");
		const old = jobFile(root, "failed", id);
		const next = jobFile(root, "pending", id);
		job.retriedAt = new Date().toISOString();
		delete job.error;
		delete job.unknownOutcome;
		atomicJob(old, job);
		fs.renameSync(old, next);
		return job;
	});
}

export function log(root, event, id, detail = "") {
	const safe = String(detail).replace(/[\r\n]+/g, " ").slice(0, 400);
	const file = path.join(queueRoot(root), "worker.log");
	const existing = fs.lstatSync(file, { throwIfNoEntry: false });
	if (existing && !existing.isFile()) throw new Error("Memory worker log must be a regular file");
	fs.appendFileSync(file,
		`${new Date().toISOString()} ${event} ${id} ${safe}\n`, { mode: 0o600 });
}

export function workerPath() { return path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.mjs"); }

export function wake(root = defaultRoot(), agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent")) {
	if ((!list(root).length && !list(root, "running").length) ||
		fs.existsSync(path.join(queueRoot(root), "paused"))) return;
	const child = spawn(process.execPath, [workerPath(), "--root", root, "--agent-dir", agentDir], {
		stdio: "ignore", detached: true, env: { ...process.env },
	});
	child.on("error", (error) => log(root, "worker-spawn-failed", "-", error.message));
	child.unref();
}
