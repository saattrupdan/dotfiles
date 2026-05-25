/**
 * Git worktree helpers for the subagent extension.
 *
 * When an agent has `worktree: true` in its frontmatter, we:
 *   1. Create a fresh worktree at a temp path on a new branch
 *   2. Run the subagent with that worktree as its cwd
 *   3. On exit (success, failure, or abort), merge the branch back into
 *      the parent worktree's current HEAD, then remove the worktree and
 *      delete the branch.
 *
 * All merges into the same parent repo are serialized via an in-process
 * mutex so that parallel subagents don't race on `.git/index`.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface WorktreeHandle {
	/** Absolute path of the parent (launching) repository's top-level. */
	parentRepoRoot: string;
	/** Absolute path of the temporary worktree directory. */
	worktreePath: string;
	/** Name of the temporary branch created for this subagent. */
	branchName: string;
	/** Sha the worktree branch started from (the parent's HEAD at create time). */
	baseSha: string;
}

export interface WorktreeCleanupResult {
	merged: boolean;
	skipped: boolean;
	message: string;
}

interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

function execGit(cwd: string, args: string[]): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d) => {
			stdout += d.toString();
		});
		proc.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		proc.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
		proc.on("error", (err) => resolve({ code: 1, stdout, stderr: stderr + String(err) }));
	});
}

async function git(cwd: string, args: string[]): Promise<string> {
	const r = await execGit(cwd, args);
	if (r.code !== 0) {
		throw new Error(`git ${args.join(" ")} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
	}
	return r.stdout.trim();
}

/**
 * Live registry of worktrees this process created and hasn't cleaned up yet.
 * Used by the signal/exit handlers below to release leftover worktrees and
 * branches if the parent pi process is killed abruptly (Ctrl+C twice, SIGTERM,
 * terminal close, crash) before `mergeAndCleanup` runs.
 */
const activeWorktrees = new Set<WorktreeHandle>();

/** Best-effort synchronous teardown — must be safe to call from signal/exit handlers. */
function cleanupHandleSync(h: WorktreeHandle): void {
	const opts = { cwd: h.parentRepoRoot, stdio: "ignore" as const };
	// Try the polite path first.
	spawnSync("git", ["worktree", "remove", "--force", h.worktreePath], opts);
	// If that didn't fully work (locked, in-use, missing), nuke the dir and
	// let `prune` reconcile the worktree admin records.
	try {
		fs.rmSync(h.worktreePath, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	spawnSync("git", ["worktree", "prune"], opts);
	spawnSync("git", ["branch", "-D", h.branchName], opts);
	// Remove the mkdtemp parent dir.
	try {
		fs.rmSync(path.dirname(h.worktreePath), { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

let exitHandlersRegistered = false;
function registerExitHandlers(): void {
	if (exitHandlersRegistered) return;
	exitHandlersRegistered = true;

	const drain = () => {
		for (const h of activeWorktrees) {
			try {
				cleanupHandleSync(h);
			} catch {
				/* ignore */
			}
		}
		activeWorktrees.clear();
	};

	process.on("exit", drain);
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(sig, () => {
			drain();
			// Re-raise default behavior so the parent sees the correct exit code.
			process.exit(sig === "SIGINT" ? 130 : sig === "SIGTERM" ? 143 : 129);
		});
	}
}

/**
 * Reclaim worktrees and branches left over from previous pi runs that died
 * before they could clean up. Safe to run with sibling pi sessions active:
 *   - `git worktree prune` only removes admin records for worktree directories
 *     that no longer exist on disk, so it can't disturb a live sibling.
 *   - Branches are only deleted when no worktree is currently linked to them
 *     (checked via `worktree list --porcelain`).
 *
 * Tracked per-repo so it runs at most once per process per repo.
 */
const sweptRepos = new Set<string>();
export async function sweepOrphanedSubagentArtifacts(repoRoot: string): Promise<void> {
	if (sweptRepos.has(repoRoot)) return;
	sweptRepos.add(repoRoot);
	try {
		await execGit(repoRoot, ["worktree", "prune"]);
		const wtList = await execGit(repoRoot, ["worktree", "list", "--porcelain"]);
		const linkedBranches = new Set<string>();
		for (const line of wtList.stdout.split("\n")) {
			const m = /^branch refs\/heads\/(.+)$/.exec(line.trim());
			if (m) linkedBranches.add(m[1]);
		}
		const brList = await execGit(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads/subagent/"]);
		if (brList.code !== 0) return;
		for (const raw of brList.stdout.split("\n")) {
			const branch = raw.trim();
			if (!branch || linkedBranches.has(branch)) continue;
			await execGit(repoRoot, ["branch", "-D", branch]);
		}
	} catch {
		/* best-effort */
	}
}

/** Serialize merges per-repo so parallel subagents don't fight over the index. */
const repoLocks = new Map<string, Promise<unknown>>();
export function withRepoMergeLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
	const prev = repoLocks.get(repoRoot) ?? Promise.resolve();
	const next = prev.then(fn, fn);
	repoLocks.set(
		repoRoot,
		next.catch(() => {}),
	);
	return next;
}

/** Stream `git <args>` stdout straight to a file (binary-safe). */
function gitToFile(cwd: string, args: string[], filePath: string): Promise<ExecResult> {
	return new Promise((resolve) => {
		const out = fs.createWriteStream(filePath);
		const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		proc.stdout.pipe(out);
		proc.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		proc.on("close", (code) => {
			out.end(() => resolve({ code: code ?? 0, stdout: "", stderr }));
		});
		proc.on("error", (err) => {
			out.end(() => resolve({ code: 1, stdout: "", stderr: stderr + String(err) }));
		});
	});
}

/**
 * Capture all changes in `worktreePath` (tracked modifications, additions,
 * deletions, and untracked files) as a binary-safe patch against `baseSha`,
 * then apply it to the parent repo with 3-way merge to tolerate parent HEAD
 * having advanced since the worktree was created.
 */
async function applyUncommittedChanges(
	worktreePath: string,
	parentRepoRoot: string,
	baseSha: string,
): Promise<{ ok: boolean; empty: boolean; error?: string }> {
	const addRes = await execGit(worktreePath, ["add", "-A"]);
	if (addRes.code !== 0) {
		return { ok: false, empty: false, error: `git add -A failed: ${addRes.stderr.trim()}` };
	}

	const patchPath = path.join(
		os.tmpdir(),
		`pi-subagent-patch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.patch`,
	);
	try {
		const diffRes = await gitToFile(
			worktreePath,
			["diff", "--cached", "--binary", "--no-color", baseSha],
			patchPath,
		);
		if (diffRes.code !== 0) {
			return { ok: false, empty: false, error: `git diff failed: ${diffRes.stderr.trim()}` };
		}
		const stat = await fs.promises.stat(patchPath).catch(() => null);
		if (!stat || stat.size === 0) {
			return { ok: true, empty: true };
		}
		const applyRes = await execGit(parentRepoRoot, [
			"apply",
			"--3way",
			"--whitespace=nowarn",
			patchPath,
		]);
		if (applyRes.code !== 0) {
			return { ok: false, empty: false, error: applyRes.stderr.trim() || applyRes.stdout.trim() };
		}
		return { ok: true, empty: false };
	} finally {
		await fs.promises.unlink(patchPath).catch(() => {});
	}
}

/** Detect if `cwd` is inside a git work tree and return its top-level. */
export async function findRepoRoot(cwd: string): Promise<string | null> {
	const r = await execGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (r.code !== 0) return null;
	const top = r.stdout.trim();
	return top || null;
}

/** Create a new worktree + branch for a subagent. */
export async function createWorktree(parentCwd: string, agentName: string): Promise<WorktreeHandle> {
	const repoRoot = await findRepoRoot(parentCwd);
	if (!repoRoot) {
		throw new Error(`worktree: true was requested but ${parentCwd} is not inside a git repository.`);
	}

	const baseSha = await git(repoRoot, ["rev-parse", "HEAD"]).catch(() => "");
	if (!baseSha) {
		// No commits yet — git worktree add can't work. Surface a clean error.
		throw new Error("worktree: true requires the parent repository to have at least one commit.");
	}

	const safeAgent = agentName.replace(/[^\w.-]+/g, "_");
	const rand = Math.random().toString(36).slice(2, 8);
	const stamp = `${Date.now().toString(36)}-${rand}`;
	const branchName = `subagent/${safeAgent}-${stamp}`;
	const wtParent = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-wt-"));
	const worktreePath = path.join(wtParent, safeAgent);

	await git(repoRoot, ["worktree", "add", "-b", branchName, worktreePath, baseSha]);

	const handle: WorktreeHandle = { parentRepoRoot: repoRoot, worktreePath, branchName, baseSha };
	registerExitHandlers();
	activeWorktrees.add(handle);
	return handle;
}

/**
 * Merge the subagent's branch back into the parent repo's HEAD, then
 * tear the worktree down. Best-effort: errors are returned in `message`
 * rather than thrown so the caller can always surface them to the model
 * without losing the subagent's own output.
 */
export async function mergeAndCleanup(handle: WorktreeHandle): Promise<WorktreeCleanupResult> {
	return withRepoMergeLock(handle.parentRepoRoot, async () => {
		const { parentRepoRoot, worktreePath, branchName, baseSha } = handle;

		let merged = false;
		let skipped = false;
		const messages: string[] = [];

		try {
			// Did the subagent actually produce any commits?
			const headSha = await git(parentRepoRoot, ["rev-parse", branchName]).catch(() => baseSha);
			if (headSha === baseSha) {
				// No commits — but the subagent may have left uncommitted
				// changes in the working tree (e.g. when explicitly asked
				// not to commit). Capture those as a patch and apply them
				// to the parent so the work isn't discarded.
				const applied = await applyUncommittedChanges(worktreePath, parentRepoRoot, baseSha);
				if (applied.empty) {
					skipped = true;
					messages.push(`Worktree branch ${branchName} had no new commits or changes; nothing to propagate.`);
				} else if (applied.ok) {
					merged = true;
					messages.push(`Propagated uncommitted worktree changes from ${branchName} to parent (no commit).`);
				} else {
					messages.push(
						`Failed to apply uncommitted worktree changes from ${branchName}: ${applied.error ?? "unknown error"}`,
					);
				}
			} else {
				const r = await execGit(parentRepoRoot, [
					"merge",
					"--no-ff",
					"-m",
					`merge subagent worktree ${branchName}`,
					branchName,
				]);
				if (r.code === 0) {
					merged = true;
					messages.push(`Merged ${branchName} into parent worktree.`);
				} else {
					messages.push(
						`Failed to merge ${branchName} into parent worktree (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`,
					);
					// Try to abort an in-progress merge so we leave the repo clean.
					await execGit(parentRepoRoot, ["merge", "--abort"]);
				}
			}
		} catch (err) {
			messages.push(`Merge error: ${(err as Error).message}`);
		}

		// Always remove the worktree. If git's own command fails (locked file,
		// filesystem race, etc.), fall back to nuking the directory and
		// running `worktree prune` so admin records still get reconciled.
		const rmRes = await execGit(parentRepoRoot, ["worktree", "remove", "--force", worktreePath]);
		if (rmRes.code !== 0) {
			try {
				await fs.promises.rm(worktreePath, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
			const pruneRes = await execGit(parentRepoRoot, ["worktree", "prune"]);
			if (pruneRes.code !== 0) {
				messages.push(
					`Failed to remove worktree ${worktreePath}: ${rmRes.stderr.trim() || rmRes.stdout.trim()}`,
				);
			}
		}

		// Delete the temp branch (force, since it may be unmerged on failure).
		const brRes = await execGit(parentRepoRoot, ["branch", "-D", branchName]);
		if (brRes.code !== 0 && !brRes.stderr.includes("not found")) {
			messages.push(`Failed to delete branch ${branchName}: ${brRes.stderr.trim() || brRes.stdout.trim()}`);
		}

		// Best-effort: remove the temp parent directory holding the worktree.
		try {
			await fs.promises.rm(path.dirname(worktreePath), { recursive: true, force: true });
		} catch {
			/* ignore */
		}

		activeWorktrees.delete(handle);
		return { merged, skipped, message: messages.join(" ") };
	});
}
