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

import { spawn } from "node:child_process";
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

	return { parentRepoRoot: repoRoot, worktreePath, branchName, baseSha };
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
				skipped = true;
				messages.push(`Worktree branch ${branchName} had no new commits; nothing to merge.`);
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

		// Always remove the worktree.
		const rmRes = await execGit(parentRepoRoot, ["worktree", "remove", "--force", worktreePath]);
		if (rmRes.code !== 0) {
			messages.push(`Failed to remove worktree ${worktreePath}: ${rmRes.stderr.trim() || rmRes.stdout.trim()}`);
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

		return { merged, skipped, message: messages.join(" ") };
	});
}
