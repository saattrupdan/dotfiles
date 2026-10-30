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

import { counts, wake } from "../memory-handoff/queue.mjs";

import { recoverFailed } from "./failed-requests.mjs";
import { failedWorkSignature, fingerprintBundle } from "./fingerprint.mjs";

const DEFAULT_ROOT = path.join(os.homedir(), "memory");
const DEFAULT_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const PROMPT = "Clean every safely repairable lint issue in the OKF memory bundle. Call lint_concepts first. " +
	"Call repair_embeddings to restore missing or stale vectors and remove truly orphaned vectors without changing Markdown. " +
	"Remove exactly repeated paragraphs only when all unique facts and context remain. " +
	"Merge concepts by removal only when their full Markdown and metadata are identical; " +
	"the removal tool enforces this and requires no inbound links. " +
	"Removal archives the original; record its archive path. Never delete a concept solely because it is orphaned. " +
	"For each broken link, search for its intended concept and repair the target only with clear evidence. " +
	"If no target can be established, remove only the Markdown link markup, keeping its visible label and surrounding text. " +
	"Do not invent facts or delete unique content. Review every issue yourself; no human will triage leftovers. " +
	"Continue through all lint findings; do not stop after a few updates. Lint again after all repairs. " +
	"If a non-orphan issue remains because a safe repair is impossible, report its kind and cause for automatic retry. " +
	"Report only issue counts, repair counts and archive paths.";

function append(root, event, detail = "") {
	const file = path.join(root, "cleaning.log");
	if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Cleaning log must not be a symlink");
	fs.appendFileSync(file, `${new Date().toISOString()} ${event} ${String(detail).replace(/[\r\n]/g, " ").slice(0, 500)}\n`,
		{ mode: 0o600 });
}
function readState(root) {
	try { return JSON.parse(fs.readFileSync(path.join(root, ".cleaning-state.json"), "utf8")); }
	catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}
function saveState(root, state) {
	const file = path.join(root, ".cleaning-state.json");
	const temp = `${file}.${process.pid}.tmp`;
	try { fs.writeFileSync(temp, JSON.stringify(state), { flag: "wx", mode: 0o600 }); fs.renameSync(temp, file); }
	finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function requestsIncomplete(requests) {
	return !!(requests?.errors || requests?.paused || requests?.interrupted ||
		requests?.remainingFailed || requests?.remainingUnreviewed);
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

export async function runCleaning({ root = DEFAULT_ROOT, agentDir = DEFAULT_AGENT_DIR, timeoutMs = 20 * 60_000,
	recover = recoverFailed, fingerprint = fingerprintBundle, wakeQueue = wake } = {}) {
	if (!fs.statSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error("Memory bundle is not a real directory");
	const lock = acquire(root);
	if (!lock) return { skipped: true, reason: "already running" };
	let child, interrupted = false;
	const reviewController = new globalThis.AbortController();
	const interrupt = () => {
		interrupted = true;
		reviewController.abort();
		if (!child?.pid) return;
		try { process.kill(-child.pid, "SIGTERM"); }
		catch (error) { if (error.code !== "ESRCH") throw error; }
	};
	process.once("SIGTERM", interrupt);
	process.once("SIGINT", interrupt);
	const startedAt = new Date().toISOString();
	let requests, cleaningStarted = false;
	const reviewQueue = async (onlyDefinite = false) => {
		try { requests = await recover({ root, agentDir, onlyDefinite, signal: reviewController.signal }); }
		catch (error) {
			requests = { errors: 1 };
			append(root, "request-review-failed", error.message);
		}
		append(root, "requests", JSON.stringify(requests));
	};
	try {
		const previous = readState(root);
		const before = fingerprint(root);
		const failedBefore = failedWorkSignature(root);
		const queue = counts(root);
		if (queue.pending || queue.running) {
			wakeQueue(root, agentDir);
			if (queue.failed) await reviewQueue(true); // No read-only verification while another writer is active.
			return { skipped: true, reason: "memory writes still pending", requests };
		}
		const unchanged = (previous?.status === "done" || previous?.status === "incomplete") &&
			previous.bundleFingerprint === before;
		if (unchanged && previous.status === "done" && previous.failedWorkSignature === failedBefore) {
			return { skipped: true, reason: "memory unchanged" };
		}
		append(root, "started");
		saveState(root, { startedAt, status: "running" });
		cleaningStarted = true;
		if (unchanged) {
			await reviewQueue();
			const incomplete = requestsIncomplete(requests);
			const done = { ...previous, startedAt, completedAt: new Date().toISOString(),
				status: incomplete ? "incomplete" : "done", requests, cleaningSkipped: true,
				failedWorkSignature: incomplete ? null : failedWorkSignature(root) };
			saveState(root, done);
			if (incomplete) append(root, "incomplete", `requests=${JSON.stringify(requests)}`);
			return done;
		}
		const result = await new Promise((resolve, reject) => {
			const env = { ...process.env, PI_MEMORY_CLEANING_ONLY: "1", PI_MEMORY_RECALL_ONLY: "0" };
			child = spawn(path.join(agentDir, "bin", "pi"), ["--agent", "librarian", "--no-session", "--mode", "json", "-p", PROMPT],
				{ stdio: ["ignore", "pipe", "pipe"], detached: true, env });
			let lintRuns = 0, repairs = 0, removals = 0, failures = 0, issueSummary = {}, buffer = "", stderr = "", timedOut = false, force;
			let lastLintFingerprint, lastLintIssues, sequence = 0, lastLint = 0, lastMutation = 0;
			const archives = [];
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
							lastLint = ++sequence;
							lintRuns++;
							const issues = event.result?.details?.issues;
							lastLintIssues = Array.isArray(issues) && issues.every((issue) =>
								issue && typeof issue.kind === "string" && typeof issue.path === "string") ? issues : undefined;
							if (lastLintIssues) issueSummary = Object.fromEntries(
								[...new Set(lastLintIssues.map((issue) => issue.kind))].sort()
									.map((kind) => [kind, lastLintIssues.filter((issue) => issue.kind === kind).length]));
						const inspected = event.result?.details?.fingerprint;
						lastLintFingerprint = typeof inspected === "string" && inspected === fingerprint(root)
							? inspected : undefined;
						} else if (event.toolName === "repair_embeddings") {
							lastMutation = ++sequence;
							repairs += event.result?.details?.attempted ?? 0;
							repairs += event.result?.details?.pruned?.length ?? 0;
						} else if (event.toolName === "update_concept") {
							lastMutation = ++sequence;
							repairs++;
							if (typeof event.result?.details?.archive === "string") archives.push(event.result.details.archive);
						} else if (event.toolName === "remove_concept") {
							lastMutation = ++sequence;
							removals++;
							if (typeof event.result?.details?.archive === "string") archives.push(event.result.details.archive);
						}
					} catch (error) {
						if (error instanceof SyntaxError) continue; // Ignore non-JSON launcher status lines.
						failures++;
						stderr = `Could not fingerprint lint result: ${error.message}`;
					}
				}
			});
			child.stderr.on("data", (part) => { stderr = (stderr + part.toString("utf8")).slice(-1_000); });
			child.on("error", (error) => { clearTimeout(timer); clearTimeout(force); reject(error); });
			child.on("close", (code) => {
				clearTimeout(timer); clearTimeout(force);
				if (interrupted || timedOut || code !== 0 || failures || !lintRuns || lastMutation > lastLint ||
					!lastLintIssues || !lastLintFingerprint || lastLintFingerprint !== fingerprint(root) ||
					lastLintIssues.some((issue) => issue.kind !== "orphan")) {
					reject(new Error(interrupted ? "Cleaning session interrupted; next run will start from lint" :
						timedOut ? "Cleaning session timed out" :
						`Cleaning incomplete: exit=${code}, lint=${lintRuns}, toolErrors=${failures}, ` +
						`finalLint=${lastLint >= lastMutation}, fingerprint=${!!lastLintFingerprint}, ` +
						`remaining=${JSON.stringify(Object.fromEntries(Object.entries(issueSummary)
							.filter(([kind]) => kind !== "orphan")))}, stderr=${stderr.slice(-350)}`));
				} else resolve({ lintRuns, repairs, removals, archives, issues: issueSummary, lastLintFingerprint });
			});
		});
		if (!interrupted) await reviewQueue();
		const { lastLintFingerprint, ...report } = result;
		const incomplete = requestsIncomplete(requests);
		const done = { startedAt, completedAt: new Date().toISOString(), status: incomplete ? "incomplete" : "done",
			requests, ...report, bundleFingerprint: lastLintFingerprint,
			failedWorkSignature: incomplete ? null : failedWorkSignature(root) };
		saveState(root, done);
		append(root, done.status, `lint=${done.lintRuns} updates=${done.repairs} removals=${done.removals} ` +
			`issues=${JSON.stringify(done.issues)} requests=${JSON.stringify(requests)} archives=${done.archives.join(",")}`);
		return done;
	} catch (error) {
		if (cleaningStarted && !interrupted && !requests) await reviewQueue();
		saveState(root, { startedAt, completedAt: new Date().toISOString(), status: "failed", requests, error: error.message });
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
	runCleaning().then((result) => { if (result.status === "failed" || result.status === "incomplete") process.exitCode = 1; })
		.catch((error) => { append(DEFAULT_ROOT, "crash", error.message); process.exitCode = 1; });
}
