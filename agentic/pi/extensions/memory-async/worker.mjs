#!/usr/bin/env node
/**
 * Background worker for the memory-async extension.
 *
 * Drains the persistent queue written by `index.ts` into Understory over MCP
 * (POST http://localhost:3800/mcp, stateless JSON-RPC — no `initialize`
 * handshake is required by this server). One worker at a time, FIFO, so an
 * `memory_add` and a later `memory_update` touching the same concept can never
 * race each other inside the librarian.
 *
 * Mutations are slow: the Understory librarian takes a median of ~17s and has
 * been observed at 14min, which is exactly why the writes are not run in the
 * conversational turn.
 *
 * Queue layout (default ~/.pi/agent/memory-async/):
 *   queue/NNNNNN.json      pending, processed in name order
 *   inflight/NNNNNN.json   claimed by this worker
 *   done/NNNNNN.json       applied successfully
 *   failed/NNNNNN.json     permanently failed after MAX_ATTEMPTS
 *   worker.log             one tab-separated line per outcome
 *   worker.pid             lock; a live pid means another worker owns the queue
 *
 * `MEMORY_ASYNC_DRY_RUN=1` skips the network call (plumbing smoke test).
 */

/* global Buffer, setTimeout, clearTimeout, URL, process */
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = process.env.MEMORY_ASYNC_DIR ?? path.join(os.homedir(), ".pi", "agent", "memory-async");
const QUEUE = path.join(ROOT, "queue");
const INFLIGHT = path.join(ROOT, "inflight");
const DONE = path.join(ROOT, "done");
const FAILED = path.join(ROOT, "failed");
const LOG_FILE = path.join(ROOT, "worker.log");
const PID_FILE = path.join(ROOT, "worker.pid");

const MCP_URL = process.env.UNDERSTORY_MCP_URL ?? "http://localhost:3800/mcp";
const MAX_ATTEMPTS = Number(process.env.MEMORY_ASYNC_MAX_ATTEMPTS ?? 3);
const RETRY_BASE_MS = Number(process.env.MEMORY_ASYNC_RETRY_MS ?? 30_000);
const CALL_TIMEOUT_MS = Number(process.env.MEMORY_ASYNC_CALL_TIMEOUT_MS ?? 45 * 60 * 1000);
const IDLE_EXIT_MS = 3_000;
const MAX_LIFETIME_MS = 60 * 60 * 1000;
const DONE_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const STALE_INFLIGHT_MS = 30 * 60 * 1000;
const DRY_RUN = process.env.MEMORY_ASYNC_DRY_RUN === "1";

function log(status, id, tool, note) {
	const line = `${new Date().toISOString()}\t${status}\t${id}\t${tool ?? "-"}\t${note ?? ""}\n`;
	try {
		fs.appendFileSync(LOG_FILE, line, "utf-8");
	} catch {
		// Logging must never take down the worker.
	}
	if (process.argv.includes("--verbose")) process.stderr.write(line);
}

function ensureDirs() {
	for (const dir of [QUEUE, INFLIGHT, DONE, FAILED]) fs.mkdirSync(dir, { recursive: true });
}

/** Acquire the singleton lock. Returns false when another live worker owns the queue. */
function acquireLock() {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = fs.openSync(PID_FILE, "wx");
			fs.writeSync(fd, String(process.pid));
			fs.closeSync(fd);
			return true;
		} catch (err) {
			if (err?.code !== "EEXIST") throw err;
			let pid;
			try {
				pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10) || 0;
			} catch {
				continue;
			}
			let alive = true;
			try {
				process.kill(pid, 0);
			} catch {
				alive = false;
			}
			if (alive) return false;
			try {
				fs.unlinkSync(PID_FILE); // stale lock from a killed worker
				log("stale-lock", "-", "-", `replaced pid ${pid}`);
			} catch {
				return false;
			}
		}
	}
	return false;
}

function releaseLock() {
	try {
		const owner = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
		if (owner === process.pid) fs.unlinkSync(PID_FILE);
	} catch {
		// Already gone.
	}
}

/** Parse a JSON-RPC response body that may be bare JSON or an SSE frame. */
function parseRpcBody(text, contentType) {
	if (contentType.includes("text/event-stream")) {
		let last;
		for (const block of text.split(/\r?\n\r?\n/)) {
			for (const line of block.split(/\r?\n/)) {
				if (!line.startsWith("data:")) continue;
				try {
					last = JSON.parse(line.slice(5).trim());
				} catch {
					// Ignore keep-alive and non-JSON frames.
				}
			}
		}
		if (!last) throw new Error("empty SSE response from MCP server");
		return last;
	}
	return JSON.parse(text);
}

/**
 * One MCP `tools/call`. Plain node:http rather than fetch: undici caps response
 * bodies at 300s of silence, and these librarian runs routinely outrun that
 * (measured 341s and 435s today), which would surface as `fetch failed` on a
 * write the server is still applying. A long timeout with an explicit watchdog
 * lets the call finish; a watchdog trip is an *unknown outcome*, not a failure,
 * so it must not be retried blindly.
 */
class UnknownOutcomeError extends Error {}

let rpcId = 0;

function callTool(tool, args) {
	if (DRY_RUN) return Promise.resolve({ text: "dry-run: no MCP call made" });
	return new Promise((resolve, reject) => {
		const url = new URL(MCP_URL);
		const lib = url.protocol === "https:" ? https : http;
		const payload = JSON.stringify({
			jsonrpc: "2.0",
			id: ++rpcId,
			method: "tools/call",
			params: { name: tool, arguments: args },
		});
		let watchdog;
		let settled = false;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(watchdog);
			fn(value);
		};

		const req = lib.request(
			url,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					"content-length": Buffer.byteLength(payload),
				},
				timeout: 0, // no inactivity timeout; the watchdog below bounds the call
			},
			(res) => {
				let body = "";
				res.setEncoding("utf-8");
				res.on("data", (chunk) => {
					body += chunk;
				});
				res.on("end", () => {
					if (res.statusCode < 200 || res.statusCode >= 300) {
						finish(reject, new Error(`HTTP ${res.statusCode} ${body.slice(0, 200)}`));
						return;
					}
					let msg;
					try {
						msg = parseRpcBody(body, res.headers["content-type"] ?? "application/json");
					} catch (err) {
						finish(reject, new Error(`unreadable response: ${String(err?.message ?? err)}`));
						return;
					}
					if (msg.error) {
						finish(reject, new Error(`jsonrpc ${msg.error.code}: ${msg.error.message}`));
						return;
					}
					const text = (msg.result?.content ?? []).map((c) => c?.text ?? "").join("\n");
					if (msg.result?.isError) {
						finish(reject, new Error(`tool error: ${text.slice(0, 300)}`));
						return;
					}
					finish(resolve, { text });
				});
				res.on("error", (err) => finish(reject, err));
			},
		);

		req.on("error", (err) => finish(reject, err));
		watchdog = setTimeout(() => {
			req.destroy();
			finish(reject, new UnknownOutcomeError(`no response within ${Math.round(CALL_TIMEOUT_MS / 1000)}s`));
		}, CALL_TIMEOUT_MS);
		req.end(payload);
	});
}

function readdirOrEmpty(dir) {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

function pendingJobs() {
	const names = readdirOrEmpty(QUEUE).filter((n) => n.endsWith(".json")).sort();
	const jobs = [];
	for (const name of names) {
		const file = path.join(QUEUE, name);
		let job;
		try {
			job = JSON.parse(fs.readFileSync(file, "utf-8"));
		} catch (err) {
			// A half-written job cannot be trusted; park it for inspection.
			try {
				fs.renameSync(file, path.join(FAILED, `${name}.unparsable`));
			} catch { /* someone else moved it */ }
			log("unparsable", name, "-", String(err?.message ?? err));
			continue;
		}
		jobs.push({ name, file, job });
	}
	return jobs;
}

/** Claim a job by atomic rename. Returns null when another worker got there first. */
function claim(entry) {
	const target = path.join(INFLIGHT, entry.name);
	try {
		fs.renameSync(entry.file, target);
	} catch (err) {
		if (err?.code === "ENOENT") return null;
		throw err;
	}
	return { ...entry, file: target };
}

function requeue(job, name) {
	const attempts = (job.attempts ?? 0) + 1;
	job.notBefore = Date.now() + RETRY_BASE_MS * 2 ** (attempts - 1);
	job.attempts = attempts;
	const tmp = path.join(QUEUE, `${name}.tmp`);
	fs.writeFileSync(tmp, JSON.stringify(job), "utf-8");
	fs.renameSync(tmp, path.join(QUEUE, name));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
	ensureDirs();
	if (!acquireLock()) {
		log("skip", "-", "-", "another worker holds the queue");
		return;
	}
	const startedAt = Date.now();
	let idleSince = null;

	for (;;) {
		if (Date.now() - startedAt > MAX_LIFETIME_MS) {
			log("exit", "-", "-", "max lifetime reached");
			break;
		}
		reclaimStaleInflight();
		const jobs = pendingJobs();
		let worked = false;
		let waitMs = 0;

		for (const entry of jobs) {
			const notBefore = entry.job.notBefore ?? 0;
			if (notBefore > Date.now()) {
				// Strict FIFO: never apply a later write ahead of a retried one,
				// or an `update` could land before the `add` it refers to.
				waitMs = Math.max(waitMs, Math.min(notBefore - Date.now(), 60_000));
				break;
			}
			const claimed = claim(entry);
			if (!claimed) continue;
			worked = true;
			const { job } = claimed;
			const id = claimed.name.replace(/\.json$/, "");
			try {
				const { text } = await callTool(job.tool, job.arguments ?? {});
				fs.renameSync(claimed.file, path.join(DONE, claimed.name));
				log("ok", id, job.tool, text.replace(/\s+/g, " ").slice(0, 200));
			} catch (err) {
				const note = String(err?.message ?? err).replace(/\s+/g, " ").slice(0, 300);
				const attempts = (job.attempts ?? 0) + 1;
				if (err instanceof UnknownOutcomeError || attempts >= MAX_ATTEMPTS) {
					job.unknownOutcome = err instanceof UnknownOutcomeError;
					job.attempts = attempts;
					job.error = note;
					fs.writeFileSync(claimed.file, JSON.stringify(job), "utf-8");
					fs.renameSync(claimed.file, path.join(FAILED, claimed.name));
					log("failed", id, job.tool, note);
				} else {
					requeue(job, claimed.name);
					fs.unlinkSync(claimed.file); // the queue copy owns it now; a leftover would be reclaimed and applied twice
					log("retry", id, job.tool, `attempt ${attempts}: ${note}`);
				}
			}
		}

		if (worked) {
			idleSince = null;
			continue;
		}
		if (waitMs > 0) {
			idleSince = null;
			await sleep(waitMs);
			continue;
		}
		idleSince ??= Date.now();
		if (Date.now() - idleSince >= IDLE_EXIT_MS) break;
		await sleep(500);
	}

	pruneDone();
	releaseLock();
}

/**
 * Re-queue jobs left in inflight/ by a worker that was killed mid-write. A
 * mutation can run 14min, so the cutoff is generous; re-applying an
 * already-applied write is acceptable because the librarian merges into
 * existing concepts rather than blindly appending.
 */
function reclaimStaleInflight() {
	for (const name of readdirOrEmpty(INFLIGHT)) {
		const file = path.join(INFLIGHT, name);
		try {
			if (Date.now() - fs.statSync(file).mtimeMs < STALE_INFLIGHT_MS) continue;
			const job = JSON.parse(fs.readFileSync(file, "utf-8"));
			requeue(job, name);
			fs.unlinkSync(file);
			log("reclaim", name.replace(/\.json$/, ""), job.tool, "recovered from a dead worker");
		} catch { /* another worker won the race */ }
	}
}

function pruneDone() {
	const cutoff = Date.now() - DONE_RETENTION_MS;
	for (const name of readdirOrEmpty(DONE)) {
		const file = path.join(DONE, name);
		try {
			if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
		} catch { /* racing with another prune */ }
	}
}

for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		releaseLock();
		process.exit(0);
	});
}
process.on("exit", releaseLock);

main().catch((err) => {
	log("crash", "-", "-", String(err?.stack ?? err));
	releaseLock();
	process.exitCode = 1;
});
