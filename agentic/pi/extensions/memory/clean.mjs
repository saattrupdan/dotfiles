#!/usr/bin/env node
/** Hourly, bounded, non-destructive librarian maintenance with durable status. */

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.join(os.homedir(), "memory");
const DEFAULT_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const PROMPT = "Perform bounded, non-destructive maintenance on the OKF memory bundle. " +
	"Call lint_concepts first. Repair at most five missing or stale embeddings by reading each concept " +
	"with search_concepts(path) and calling update_concept with its unchanged body and metadata. " +
	"Repair a broken link only if the correct existing target is unambiguous, preserving all other text. " +
	"Do not delete, merge, remove or invent concepts, discard facts, or rewrite duplicate paragraphs. " +
	"Leave orphans and ambiguous issues for review. Lint again after any repairs, then report " +
	"only remaining issue counts and successful repairs.";

function append(root, event, detail = "") {
	const file = path.join(root, "cleaning.log");
	if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Cleaning log must not be a symlink");
	fs.appendFileSync(file, `${new Date().toISOString()} ${event} ${String(detail).replace(/[\r\n]/g, " ").slice(0, 500)}\n`,
		{ mode: 0o600 });
}
function saveState(root, state) {
	const file = path.join(root, ".cleaning-state.json");
	const temp = `${file}.${process.pid}.tmp`;
	try { fs.writeFileSync(temp, JSON.stringify(state), { flag: "wx", mode: 0o600 }); fs.renameSync(temp, file); }
	finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function acquire(root) {
	const lock = path.join(root, ".cleaning.lock");
	try { fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 }); return lock; }
	catch (error) {
		if (error.code !== "EEXIST") throw error;
		const owner = Number(fs.readFileSync(lock, "utf8"));
		try { if (owner > 0) { process.kill(owner, 0); return null; } }
		catch (check) { if (check.code !== "ESRCH") return null; }
		fs.unlinkSync(lock);
		append(root, "recovered-interrupted-run", "Restarting maintenance from a fresh lint");
		return acquire(root);
	}
}

export async function runCleaning({ root = DEFAULT_ROOT, agentDir = DEFAULT_AGENT_DIR, timeoutMs = 20 * 60_000 } = {}) {
	if (!fs.statSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error("Memory bundle is not a real directory");
	const lock = acquire(root);
	if (!lock) return { skipped: true, reason: "already running" };
	let child, interrupted = false;
	const interrupt = () => {
		interrupted = true;
		if (!child?.pid) return;
		try { process.kill(-child.pid, "SIGTERM"); }
		catch (error) { if (error.code !== "ESRCH") throw error; }
	};
	process.once("SIGTERM", interrupt);
	process.once("SIGINT", interrupt);
	const startedAt = new Date().toISOString();
	append(root, "started");
	saveState(root, { startedAt, status: "running" });
	try {
		const result = await new Promise((resolve, reject) => {
			const env = { ...process.env, PI_MEMORY_CLEANING_ONLY: "1", PI_MEMORY_RECALL_ONLY: "0" };
			child = spawn(path.join(agentDir, "bin", "pi"), ["--agent", "librarian", "--no-session", "--mode", "json", "-p", PROMPT],
				{ stdio: ["ignore", "pipe", "pipe"], detached: true, env });
			let lintRuns = 0, repairs = 0, failures = 0, issueSummary = {}, buffer = "", stderr = "", timedOut = false, force;
			const stop = (signal) => {
				try { process.kill(-child.pid, signal); }
				catch (error) { if (error.code !== "ESRCH") reject(error); }
			};
			const timer = setTimeout(() => {
				timedOut = true; stop("SIGTERM"); force = setTimeout(() => stop("SIGKILL"), 2_000);
			}, timeoutMs);
			child.stdout.on("data", (part) => {
				buffer += part.toString("utf8");
				if (Buffer.byteLength(buffer) > 2_000_000) { timedOut = true; stop("SIGTERM"); return; }
				let end;
				while ((end = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
					try {
						const event = JSON.parse(line);
						if (event.type !== "tool_execution_end") continue;
						if (event.isError) failures++;
						else if (event.toolName === "lint_concepts") {
							lintRuns++;
							const issues = event.result?.details?.issues;
							if (Array.isArray(issues)) issueSummary = Object.fromEntries(
								[...new Set(issues.map((issue) => issue.kind))].sort()
									.map((kind) => [kind, issues.filter((issue) => issue.kind === kind).length]));
						} else if (event.toolName === "update_concept") repairs++;
					} catch { /* Ignore non-JSON launcher status lines. */ }
				}
			});
			child.stderr.on("data", (part) => { stderr = (stderr + part.toString("utf8")).slice(-1_000); });
			child.on("error", (error) => { clearTimeout(timer); clearTimeout(force); reject(error); });
			child.on("close", (code) => {
				clearTimeout(timer); clearTimeout(force);
				if (interrupted || timedOut || code !== 0 || failures || !lintRuns) {
					reject(new Error(interrupted ? "Cleaning session interrupted; next run will start from lint" :
						timedOut ? "Cleaning session timed out" :
						`Cleaning incomplete: exit=${code}, lint=${lintRuns}, toolErrors=${failures}, stderr=${stderr.slice(-350)}`));
				} else resolve({ lintRuns, repairs, issues: issueSummary });
			});
		});
		const done = { startedAt, completedAt: new Date().toISOString(), status: "done", ...result };
		saveState(root, done);
		append(root, "done", `lint=${done.lintRuns} repairs=${done.repairs} issues=${JSON.stringify(done.issues)}`);
		return done;
	} catch (error) {
		saveState(root, { startedAt, completedAt: new Date().toISOString(), status: "failed", error: error.message });
		append(root, "failed", error.message);
		return { status: "failed", error: error.message };
	} finally {
		child = undefined;
		process.removeListener("SIGTERM", interrupt);
		process.removeListener("SIGINT", interrupt);
		try { if (fs.readFileSync(lock, "utf8") === String(process.pid)) fs.unlinkSync(lock); } catch { /* Another process recovered. */ }
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runCleaning().then((result) => { if (result.status === "failed") process.exitCode = 1; })
		.catch((error) => { append(DEFAULT_ROOT, "crash", error.message); process.exitCode = 1; });
}
