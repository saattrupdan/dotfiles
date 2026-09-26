/** Git primitives for isolated top-level Pi sessions. */

import { execFile } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PendingSync {
	oldHead: string;
	newHead: string;
	expectedDirtyTree?: string;
	expectedDirtyBase?: string;
	expectedDirtyCommit?: string;
	expectedIndexTree?: string;
	expectedIndexCommit?: string;
}

export interface SessionManifest {
	version: 1;
	id: string;
	repoRoot: string;
	commonGitDir: string;
	worktreeRoot: string;
	launchCwdRelative: string;
	sessionHubCwd?: string;
	agentDir?: string;
	targetBranch: string;
	targetRef: string;
	baseSha: string;
	publishedHead: string;
	launchSnapshotCommit?: string;
	launchSnapshotTree?: string;
	launchIndexTree?: string;
	launchIndexCommit?: string;
	pendingSync?: PendingSync;
	copiedEnvFiles?: string[];
	createdAt: string;
	manifestPath: string;
}

export interface SessionResumeRecord {
	version: 1;
	sessionFile: string;
	repoRoot: string;
	commonGitDir: string;
	launchCwdRelative: string;
	sessionHubCwd: string;
	agentDir: string;
	targetBranch: string;
	targetRef: string;
	resumeSha: string;
	resumeRef: string;
	placeholderCwd: string;
	createdAt: string;
}

export interface LaunchPlan {
	manifest: SessionManifest;
	childCwd: string;
}

export type EnforcementResult =
	| { kind: "ok"; message?: string }
	| { kind: "needs-agent"; prompt: string }
	| { kind: "blocked"; message: string };

interface GitResult {
	stdout: string;
	stderr: string;
	code: number;
}

async function run(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<GitResult> {
	try {
		const result = await execFileAsync("git", args, {
			cwd,
			env: env ? { ...process.env, ...env } : process.env,
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		});
		return { stdout: result.stdout, stderr: result.stderr, code: 0 };
	} catch (error) {
		const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
		return {
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? failure.message,
			code: typeof failure.code === "number" ? failure.code : 1,
		};
	}
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
	const result = await run(cwd, args, env);
	if (result.code !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
	}
	return result.stdout.trim();
}

interface WorkingTreeSnapshot {
	tree: string;
}

async function workingTreeSnapshot(repoRoot: string, baseSha: string): Promise<WorkingTreeSnapshot> {
	const indexPath = path.join(os.tmpdir(), `pi-worktree-index-${process.pid}-${randomUUID()}`);
	const env = { GIT_INDEX_FILE: indexPath };
	try {
		await git(repoRoot, ["read-tree", baseSha], env);
		await git(repoRoot, ["add", "-A", "--", "."], env);
		const tree = await git(repoRoot, ["write-tree"], env);
		return { tree };
	} finally {
		await fs.promises.rm(indexPath, { force: true });
	}
}

async function indexTreeSnapshot(repoRoot: string): Promise<string> {
	const indexRaw = await git(repoRoot, ["rev-parse", "--git-path", "index"]);
	const source = resolveGitPath(repoRoot, indexRaw);
	const snapshot = path.join(os.tmpdir(), `pi-worktree-real-index-${process.pid}-${randomUUID()}`);
	try {
		await fs.promises.copyFile(source, snapshot);
		return await git(repoRoot, ["write-tree"], { GIT_INDEX_FILE: snapshot });
	} finally {
		await fs.promises.rm(snapshot, { force: true });
	}
}

interface LaunchSnapshot {
	startSha: string;
	workingTree?: string;
	indexTree?: string;
	indexCommit?: string;
}

async function removeEnvFiles(worktreeRoot: string, relativePaths: string[]): Promise<void> {
	await Promise.all(relativePaths.map((relativePath) => fs.promises.rm(path.join(worktreeRoot, relativePath), { force: true })));
}

async function copyIgnoredEnvFiles(repoRoot: string, worktreeRoot: string): Promise<string[]> {
	const ignored = await git(repoRoot, [
		"ls-files",
		"--others",
		"--ignored",
		"--exclude-standard",
		"-z",
		"--",
		":(top).env",
		":(top,glob).env.*",
	]);
	const candidates = ignored.split("\0").filter(Boolean);
	const copied: string[] = [];
	try {
		for (const relativePath of candidates) {
			const source = path.join(repoRoot, relativePath);
			const destination = path.join(worktreeRoot, relativePath);
			let sourceStat: fs.Stats;
			try {
				sourceStat = await fs.promises.lstat(source);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			if (!sourceStat.isFile()) continue;
			await fs.promises.mkdir(path.dirname(destination), { recursive: true });
			await fs.promises.copyFile(source, destination);
			copied.push(relativePath);
		}
		return copied;
	} catch (error) {
		await removeEnvFiles(worktreeRoot, copied);
		throw error;
	}
}

export async function hydrateIgnoredEnvFiles(manifest: SessionManifest): Promise<void> {
	await removeEnvFiles(manifest.worktreeRoot, manifest.copiedEnvFiles ?? []);
	manifest.copiedEnvFiles = await copyIgnoredEnvFiles(manifest.repoRoot, manifest.worktreeRoot);
	await saveManifest(manifest);
}

export async function cleanCopiedEnvFiles(manifest: SessionManifest): Promise<void> {
	await removeEnvFiles(manifest.worktreeRoot, manifest.copiedEnvFiles ?? []);
	manifest.copiedEnvFiles = [];
	await saveManifest(manifest);
}

async function createLaunchSnapshot(repoRoot: string, baseSha: string): Promise<LaunchSnapshot> {
	const snapshot = await workingTreeSnapshot(repoRoot, baseSha);
	const indexTree = await indexTreeSnapshot(repoRoot);
	const baseTree = await git(repoRoot, ["rev-parse", `${baseSha}^{tree}`]);
	if (snapshot.tree === baseTree && indexTree === baseTree) return { startSha: baseSha };
	const startSha =
		snapshot.tree === baseTree
			? baseSha
			: await git(repoRoot, [
					"commit-tree",
					snapshot.tree,
					"-p",
					baseSha,
					"-m",
					"chore: checkpoint Pi launch changes",
				]);
	const indexCommit =
		indexTree === baseTree
			? baseSha
			: await git(repoRoot, [
					"commit-tree",
					indexTree,
					"-p",
					baseSha,
					"-m",
					"chore: checkpoint Pi launch index",
				]);
	return { startSha, workingTree: snapshot.tree, indexTree, indexCommit };
}

function resolveGitPath(repoRoot: string, value: string): string {
	return path.resolve(repoRoot, value);
}

function manifestDirectory(commonGitDir: string): string {
	return path.join(commonGitDir, "pi-worktree-sessions");
}

const ADJECTIVES = [
	"brave",
	"bright",
	"cheerful",
	"clever",
	"cosmic",
	"dapper",
	"eager",
	"flamboyant",
	"gentle",
	"golden",
	"jolly",
	"lively",
	"lucky",
	"merry",
	"nimble",
	"playful",
	"radiant",
	"rapid",
	"serene",
	"sparkly",
	"spry",
	"sunny",
	"vivid",
	"witty",
] as const;

const NOUNS = [
	"badger",
	"capybara",
	"dolphin",
	"falcon",
	"ferret",
	"fox",
	"gecko",
	"hamster",
	"hedgehog",
	"heron",
	"koala",
	"lemur",
	"otter",
	"panda",
	"penguin",
	"puffin",
	"quokka",
	"rabbit",
	"raccoon",
	"robin",
	"seal",
	"sparrow",
	"tiger",
	"wombat",
] as const;

function cuteSessionId(commonGitDir: string, worktreesRoot: string): string {
	for (let attempt = 0; attempt < 20; attempt++) {
		const id = `${ADJECTIVES[randomInt(ADJECTIVES.length)]}-${NOUNS[randomInt(NOUNS.length)]}`;
		if (!fs.existsSync(path.join(manifestDirectory(commonGitDir), `${id}.json`)) && !fs.existsSync(path.join(worktreesRoot, id))) {
			return id;
		}
	}
	return `${ADJECTIVES[randomInt(ADJECTIVES.length)]}-${NOUNS[randomInt(NOUNS.length)]}-${randomInt(1000, 10000)}`;
}

export async function findRepoRoot(cwd: string): Promise<string | null> {
	const result = await run(cwd, ["rev-parse", "--show-toplevel"]);
	if (result.code !== 0 || !result.stdout.trim()) return null;
	return fs.promises.realpath(result.stdout.trim());
}

export async function findCommonGitDir(cwd: string): Promise<string | null> {
	const repoRoot = await findRepoRoot(cwd);
	if (!repoRoot) return null;
	const commonRaw = await git(repoRoot, ["rev-parse", "--git-common-dir"]);
	return fs.promises.realpath(resolveGitPath(repoRoot, commonRaw));
}

export async function loadManifest(manifestPath: string): Promise<SessionManifest> {
	const parsed = JSON.parse(await fs.promises.readFile(manifestPath, "utf8")) as SessionManifest;
	if (parsed.version !== 1 || !parsed.worktreeRoot || !parsed.targetRef) {
		throw new Error(`Invalid Pi worktree manifest: ${manifestPath}`);
	}
	return { ...parsed, manifestPath };
}

export async function findManifestForCwd(cwd: string): Promise<SessionManifest | null> {
	const repoRoot = await findRepoRoot(cwd);
	if (!repoRoot) return null;
	const commonRaw = await git(repoRoot, ["rev-parse", "--git-common-dir"]);
	const commonGitDir = resolveGitPath(repoRoot, commonRaw);
	const dir = manifestDirectory(commonGitDir);
	const entries = await fs.promises.readdir(dir).catch(() => [] as string[]);
	const resolvedCwd = await fs.promises.realpath(cwd);
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		try {
			const manifest = await loadManifest(path.join(dir, entry));
			const relative = path.relative(manifest.worktreeRoot, resolvedCwd);
			if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return manifest;
		} catch {
			// A damaged manifest must not prevent other managed sessions from loading.
		}
	}
	return null;
}

export async function saveManifest(manifest: SessionManifest): Promise<void> {
	await fs.promises.mkdir(path.dirname(manifest.manifestPath), { recursive: true });
	const temporary = `${manifest.manifestPath}.${process.pid}.tmp`;
	await fs.promises.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	await fs.promises.rename(temporary, manifest.manifestPath);
}

function inferredAgentDir(manifest: SessionManifest): string {
	return manifest.agentDir ?? path.dirname(path.dirname(path.dirname(manifest.worktreeRoot)));
}

async function canonicalSessionFilePath(sessionFile: string): Promise<string> {
	const resolved = path.resolve(sessionFile);
	const parent = await fs.promises.realpath(path.dirname(resolved));
	return path.join(parent, path.basename(resolved));
}

export function resumeRecordPath(sessionFile: string): string {
	return `${path.resolve(sessionFile)}.pi-worktree.json`;
}

export async function loadResumeRecord(sessionFile: string): Promise<SessionResumeRecord | null> {
	try {
		const parsed = JSON.parse(await fs.promises.readFile(resumeRecordPath(sessionFile), "utf8")) as SessionResumeRecord;
		const requestedSessionFile = await canonicalSessionFilePath(sessionFile).catch(() => path.resolve(sessionFile));
		const recordedSessionFile = await canonicalSessionFilePath(parsed.sessionFile).catch(() => path.resolve(parsed.sessionFile));
		if (
			parsed.version !== 1 ||
			recordedSessionFile !== requestedSessionFile ||
			!parsed.repoRoot ||
			!parsed.commonGitDir ||
			!parsed.targetRef ||
			!parsed.resumeSha ||
			!parsed.resumeRef ||
			!parsed.placeholderCwd
		) {
			throw new Error("invalid record");
		}
		return parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error(`Invalid Pi released-session record for ${sessionFile}.`, { cause: error });
	}
}

export async function sessionCwd(sessionFile: string): Promise<string | null> {
	try {
		const handle = await fs.promises.open(sessionFile, "r");
		try {
			const buffer = Buffer.alloc(16 * 1024);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
			const header = JSON.parse(firstLine) as { cwd?: unknown };
			return typeof header.cwd === "string" ? path.resolve(header.cwd) : null;
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}
}

export async function rewriteSessionCwd(sessionFile: string, cwd: string): Promise<void> {
	const content = await fs.promises.readFile(sessionFile, "utf8");
	const newline = content.indexOf("\n");
	if (newline < 0) throw new Error(`Session has no header line: ${sessionFile}`);
	const header = JSON.parse(content.slice(0, newline)) as { type?: unknown; cwd?: unknown };
	if (header.type !== "session") throw new Error(`Session has an invalid header: ${sessionFile}`);
	header.cwd = cwd;
	const temporary = `${sessionFile}.${process.pid}.tmp`;
	await fs.promises.writeFile(temporary, `${JSON.stringify(header)}\n${content.slice(newline + 1)}`, "utf8");
	await fs.promises.rename(temporary, sessionFile);
}

export async function checkpointSession(
	manifest: SessionManifest,
	sessionFile: string,
): Promise<SessionResumeRecord> {
	if (manifest.pendingSync) throw new Error("Cannot release a session while checkout synchronization is pending.");
	if (await hasInProgressOperation(manifest)) {
		throw new Error("Cannot release a session while a Git operation is in progress.");
	}
	if (await git(manifest.worktreeRoot, ["status", "--porcelain=v1"])) {
		throw new Error("Cannot release a session with uncommitted changes.");
	}

	const resolvedSessionFile = await canonicalSessionFilePath(sessionFile);
	const resumeSha = await git(manifest.worktreeRoot, ["rev-parse", "HEAD"]);
	const key = createHash("sha256").update(resolvedSessionFile).digest("hex").slice(0, 24);
	const resumeRef = `refs/pi-worktree-sessions/${key}`;
	const agentDir = inferredAgentDir(manifest);
	const placeholderCwd = path.join(agentDir, "released-sessions", key);
	const record: SessionResumeRecord = {
		version: 1,
		sessionFile: resolvedSessionFile,
		repoRoot: manifest.repoRoot,
		commonGitDir: manifest.commonGitDir,
		launchCwdRelative: manifest.launchCwdRelative,
		sessionHubCwd: manifest.sessionHubCwd ?? manifest.repoRoot,
		agentDir,
		targetBranch: manifest.targetBranch,
		targetRef: manifest.targetRef,
		resumeSha,
		resumeRef,
		placeholderCwd,
		createdAt: new Date().toISOString(),
	};

	await git(manifest.repoRoot, ["update-ref", resumeRef, resumeSha]);
	await fs.promises.mkdir(placeholderCwd, { recursive: true });
	const recordPath = resumeRecordPath(resolvedSessionFile);
	const temporary = `${recordPath}.${process.pid}.tmp`;
	await fs.promises.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
	await fs.promises.rename(temporary, recordPath);
	await rewriteSessionCwd(resolvedSessionFile, placeholderCwd);
	return record;
}

export async function checkpointSessionIfPresent(
	manifest: SessionManifest,
	sessionFile: string,
): Promise<SessionResumeRecord | null> {
	const existing = await fs.promises.lstat(sessionFile).catch(() => null);
	if (!existing?.isFile()) return null;
	return checkpointSession(manifest, sessionFile);
}

export async function assertWorktreeReleasable(manifest: SessionManifest): Promise<void> {
	if (manifest.pendingSync) throw new Error("Checkout synchronization is still pending.");
	if (await hasInProgressOperation(manifest)) throw new Error("A Git operation is still in progress.");
	if (await git(manifest.worktreeRoot, ["status", "--porcelain=v1"])) {
		throw new Error("The managed worktree is not clean.");
	}
	const ignored = await git(manifest.worktreeRoot, [
		"ls-files",
		"--others",
		"--ignored",
		"--exclude-standard",
		"--directory",
		"-z",
	]);
	const copiedEnvFiles = new Set(manifest.copiedEnvFiles ?? []);
	const unknownIgnored = ignored.split("\0").find((relativePath) => relativePath && !copiedEnvFiles.has(relativePath));
	if (unknownIgnored) {
		throw new Error(`Ignored path ${unknownIgnored} is not ephemeral session configuration; worktree was preserved.`);
	}
}

export async function checkpointWorktreeSessions(
	manifest: SessionManifest,
	requiredSessionFile?: string,
): Promise<SessionResumeRecord[]> {
	const sessionDir = sessionDirectoryForCwd(manifest.sessionHubCwd ?? manifest.repoRoot, inferredAgentDir(manifest));
	const sessionFiles = new Map<string, string>();
	if (requiredSessionFile) {
		const resolved = path.resolve(requiredSessionFile);
		const existing = await fs.promises.lstat(resolved).catch(() => null);
		if (existing?.isFile()) sessionFiles.set(await canonicalSessionFilePath(resolved), resolved);
	}
	for (const entry of await fs.promises.readdir(sessionDir, { withFileTypes: true }).catch(() => [])) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		const sessionFile = path.join(sessionDir, entry.name);
		const cwd = await sessionCwd(sessionFile);
		if (!cwd) continue;
		const relative = path.relative(manifest.worktreeRoot, cwd);
		if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
			const canonicalSessionFile = await canonicalSessionFilePath(sessionFile);
			if (!sessionFiles.has(canonicalSessionFile)) sessionFiles.set(canonicalSessionFile, sessionFile);
		}
	}
	const records: SessionResumeRecord[] = [];
	for (const sessionFile of sessionFiles.values()) records.push(await checkpointSession(manifest, sessionFile));
	return records;
}

export async function consumeResumeRecord(record: SessionResumeRecord): Promise<void> {
	await git(record.repoRoot, ["update-ref", "-d", record.resumeRef, record.resumeSha]);
	await fs.promises.rm(resumeRecordPath(record.sessionFile), { force: true });
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function acquireFileLease(leasePath: string, purpose: string): Promise<() => Promise<void>> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await fs.promises.open(leasePath, "wx");
			await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
			await handle.close();
			return async () => {
				try {
					const owner = JSON.parse(await fs.promises.readFile(leasePath, "utf8")) as { pid?: unknown };
					if (owner.pid === process.pid) await fs.promises.rm(leasePath, { force: true });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				const owner = JSON.parse(await fs.promises.readFile(leasePath, "utf8")) as { pid?: unknown };
				if (typeof owner.pid === "number" && processIsAlive(owner.pid)) {
					throw new Error(`${purpose} is already active in process ${owner.pid}.`, { cause: error });
				}
			} catch (ownerError) {
				if (ownerError instanceof Error && ownerError.message.includes("already active")) throw ownerError;
			}
			await fs.promises.rm(leasePath, { force: true });
		}
	}
	throw new Error(`Could not acquire ${purpose} lease.`);
}

export async function acquireSessionLease(sessionFile: string): Promise<() => Promise<void>> {
	const canonicalSessionFile = await canonicalSessionFilePath(sessionFile);
	return acquireFileLease(`${canonicalSessionFile}.pi-worktree.lock`, "This Pi session");
}

export async function acquireResumeClaim(sessionFile: string): Promise<() => Promise<void>> {
	const canonicalSessionFile = await canonicalSessionFilePath(sessionFile);
	return acquireFileLease(`${resumeRecordPath(canonicalSessionFile)}.lock`, "This released Pi session");
}

export function sessionDirectoryForCwd(cwd: string, agentDir?: string): string {
	const root = agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	const resolved = path.resolve(cwd);
	const safePath = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return path.join(root, "sessions", safePath);
}

async function linkSessionDirectory(sourceCwd: string, sessionHubCwd: string, agentDir: string): Promise<void> {
	const source = sessionDirectoryForCwd(sourceCwd, agentDir);
	const hub = sessionDirectoryForCwd(sessionHubCwd, agentDir);
	if (source === hub) {
		await fs.promises.mkdir(hub, { recursive: true });
		return;
	}
	await fs.promises.mkdir(hub, { recursive: true });
	await fs.promises.mkdir(path.dirname(source), { recursive: true });
	const existing = await fs.promises.lstat(source).catch(() => null);
	if (existing?.isSymbolicLink()) {
		const target = await fs.promises.realpath(source).catch(() => "");
		if (target === (await fs.promises.realpath(hub))) return;
		throw new Error(`Session directory ${source} points somewhere other than the repository session hub.`);
	}
	if (existing) {
		if (!existing.isDirectory()) throw new Error(`Session path ${source} is not a directory.`);
		for (const entry of await fs.promises.readdir(source)) {
			const from = path.join(source, entry);
			const to = path.join(hub, entry);
			if (await fs.promises.lstat(to).catch(() => null)) {
				throw new Error(`Cannot consolidate duplicate session file ${entry}.`);
			}
			await fs.promises.rename(from, to);
		}
		await fs.promises.rmdir(source);
	}
	await fs.promises.symlink(hub, source, "dir");
}

async function consolidateManagedSessionDirectories(
	commonGitDir: string,
	sessionHubCwd: string,
	agentDir: string,
): Promise<void> {
	const directory = manifestDirectory(commonGitDir);
	for (const name of await fs.promises.readdir(directory).catch(() => [] as string[])) {
		if (!name.endsWith(".json")) continue;
		try {
			const manifest = JSON.parse(await fs.promises.readFile(path.join(directory, name), "utf8")) as SessionManifest;
			const managedAgentDir = path.dirname(path.dirname(path.dirname(manifest.worktreeRoot)));
			if (path.resolve(managedAgentDir) !== path.resolve(agentDir)) continue;
			await linkSessionDirectory(
				path.join(manifest.worktreeRoot, manifest.launchCwdRelative),
				manifest.sessionHubCwd ?? sessionHubCwd,
				agentDir,
			);
		} catch {
			// A malformed or concurrently replaced old manifest must not prevent a
			// fresh session from getting its own shared session directory.
		}
	}
}

export async function createLaunchPlan(cwd: string, agentDir?: string): Promise<LaunchPlan> {
	const repoRoot = await findRepoRoot(cwd);
	if (!repoRoot) throw new Error(`${cwd} is not inside a Git working tree.`);

	let targetBranch = "";
	let baseSha = "";
	let snapshot: LaunchSnapshot | null = null;
	for (let attempt = 0; attempt < 10; attempt++) {
		targetBranch = await git(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
		if (!targetBranch) throw new Error("Pi isolation requires the launch checkout to be on a named branch.");
		baseSha = await git(repoRoot, ["rev-parse", "HEAD"]);
		const candidate = await createLaunchSnapshot(repoRoot, baseSha);
		const verifiedBranch = await git(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
		const verifiedSha = await git(repoRoot, ["rev-parse", "HEAD"]);
		const verifiedSnapshot = await workingTreeSnapshot(repoRoot, baseSha);
		const verifiedIndexTree = await indexTreeSnapshot(repoRoot);
		const snapshotTree = await git(repoRoot, ["rev-parse", `${candidate.startSha}^{tree}`]);
		const expectedIndexTree = candidate.indexTree ?? snapshotTree;
		if (
			verifiedBranch === targetBranch &&
			verifiedSha === baseSha &&
			verifiedSnapshot.tree === snapshotTree &&
			verifiedIndexTree === expectedIndexTree
		) {
			snapshot = candidate;
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	if (!snapshot) throw new Error("The launch checkout kept changing while Pi prepared its isolated worktree.");
	const commonRaw = await git(repoRoot, ["rev-parse", "--git-common-dir"]);
	const commonGitDir = resolveGitPath(repoRoot, commonRaw);
	const lexicalCwd = path.resolve(cwd);
	const resolvedCwd = await fs.promises.realpath(cwd);
	const relative = path.relative(repoRoot, resolvedCwd);
	const sessionHubCwd = path.resolve(lexicalCwd, path.relative(resolvedCwd, repoRoot));
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Launch cwd is outside the repository root.");

	const repoKey = createHash("sha256").update(commonGitDir).digest("hex").slice(0, 12);
	const root = agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	await consolidateManagedSessionDirectories(commonGitDir, sessionHubCwd, root);
	await linkSessionDirectory(lexicalCwd, sessionHubCwd, root);
	const worktreesRoot = path.join(root, "worktrees", repoKey);
	const id = cuteSessionId(commonGitDir, worktreesRoot);
	const requestedWorktreeRoot = path.join(worktreesRoot, id);
	await fs.promises.mkdir(worktreesRoot, { recursive: true });
	const hasSnapshotRefs = Boolean(snapshot.workingTree && snapshot.indexCommit);
	const manifestPath = path.join(manifestDirectory(commonGitDir), `${id}.json`);
	let worktreeRoot = requestedWorktreeRoot;
	let worktreeAdded = false;
	let worktreeLocked = false;
	let workingRefCreated = false;
	let indexRefCreated = false;
	try {
		if (hasSnapshotRefs) {
			await git(repoRoot, ["update-ref", `refs/pi-worktree-snapshots/${id}/working`, snapshot.startSha]);
			workingRefCreated = true;
			await git(repoRoot, ["update-ref", `refs/pi-worktree-snapshots/${id}/index`, snapshot.indexCommit!]);
			indexRefCreated = true;
		}
		await git(repoRoot, ["worktree", "add", "--detach", requestedWorktreeRoot, snapshot.startSha]);
		worktreeAdded = true;
		worktreeRoot = await fs.promises.realpath(requestedWorktreeRoot);
		const copiedEnvFiles = await copyIgnoredEnvFiles(repoRoot, worktreeRoot);
		await git(repoRoot, ["worktree", "lock", "--reason", "active Pi session", worktreeRoot]);
		worktreeLocked = true;

		const manifest: SessionManifest = {
			version: 1,
			id,
			repoRoot,
			commonGitDir,
			worktreeRoot,
			launchCwdRelative: relative,
			sessionHubCwd,
			agentDir: root,
			targetBranch,
			targetRef: `refs/heads/${targetBranch}`,
			baseSha,
			publishedHead: baseSha,
			...(snapshot.workingTree && snapshot.indexTree && snapshot.indexCommit
				? {
						launchSnapshotCommit: snapshot.startSha,
						launchSnapshotTree: snapshot.workingTree,
						launchIndexTree: snapshot.indexTree,
						launchIndexCommit: snapshot.indexCommit,
					}
				: {}),
			copiedEnvFiles,
			createdAt: new Date().toISOString(),
			manifestPath,
		};
		await saveManifest(manifest);
		const childCwd = path.join(worktreeRoot, relative);
		await fs.promises.mkdir(childCwd, { recursive: true });
		await linkSessionDirectory(childCwd, sessionHubCwd, root);
		return { manifest, childCwd };
	} catch (error) {
		const cleanupFailures: string[] = [];
		const attemptCleanup = async (label: string, operation: () => Promise<unknown>): Promise<void> => {
			try {
				await operation();
			} catch (cleanupError) {
				cleanupFailures.push(`${label}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
			}
		};
		await attemptCleanup("manifest removal", () => fs.promises.rm(manifestPath, { force: true }));
		if (worktreeLocked) await attemptCleanup("worktree unlock", () => git(repoRoot, ["worktree", "unlock", worktreeRoot]));
		if (worktreeAdded) {
			await attemptCleanup("worktree removal", () => git(repoRoot, ["worktree", "remove", "--force", worktreeRoot]));
		}
		if (workingRefCreated) {
			await attemptCleanup("working snapshot ref removal", () =>
				git(repoRoot, ["update-ref", "-d", `refs/pi-worktree-snapshots/${id}/working`]),
			);
		}
		if (indexRefCreated) {
			await attemptCleanup("index snapshot ref removal", () =>
				git(repoRoot, ["update-ref", "-d", `refs/pi-worktree-snapshots/${id}/index`]),
			);
		}
		if (cleanupFailures.length > 0) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`${message}; launch rollback also failed: ${cleanupFailures.join("; ")}`, { cause: error });
		}
		throw error;
	}
}

export async function createResumePlan(record: SessionResumeRecord): Promise<LaunchPlan> {
	const repoRoot = await fs.promises.realpath(record.repoRoot);
	const commonRaw = await git(repoRoot, ["rev-parse", "--git-common-dir"]);
	const commonGitDir = resolveGitPath(repoRoot, commonRaw);
	if (commonGitDir !== path.resolve(record.commonGitDir)) {
		throw new Error("The released session no longer belongs to the recorded repository.");
	}
	const protectedSha = await git(repoRoot, ["rev-parse", "--verify", `${record.resumeRef}^{commit}`]);
	if (protectedSha !== record.resumeSha) throw new Error("The released session's protected commit changed unexpectedly.");

	let startSha = record.resumeSha;
	const target = await run(repoRoot, ["rev-parse", "--verify", `${record.targetRef}^{commit}`]);
	if (target.code === 0) {
		const targetSha = target.stdout.trim();
		const contains = await run(repoRoot, ["merge-base", "--is-ancestor", record.resumeSha, targetSha]);
		if (contains.code !== 0) {
			throw new Error(`Cannot resume automatically because ${record.targetBranch} no longer contains the session commit.`);
		}
		startSha = targetSha;
	}

	const repoKey = createHash("sha256").update(commonGitDir).digest("hex").slice(0, 12);
	const worktreesRoot = path.join(record.agentDir, "worktrees", repoKey);
	const id = cuteSessionId(commonGitDir, worktreesRoot);
	const requestedWorktreeRoot = path.join(worktreesRoot, id);
	const manifestPath = path.join(manifestDirectory(commonGitDir), `${id}.json`);
	await fs.promises.mkdir(worktreesRoot, { recursive: true });
	let worktreeRoot = requestedWorktreeRoot;
	let worktreeAdded = false;
	let worktreeLocked = false;
	try {
		await git(repoRoot, ["worktree", "add", "--detach", requestedWorktreeRoot, startSha]);
		worktreeAdded = true;
		worktreeRoot = await fs.promises.realpath(requestedWorktreeRoot);
		const copiedEnvFiles = await copyIgnoredEnvFiles(repoRoot, worktreeRoot);
		await git(repoRoot, ["worktree", "lock", "--reason", "active Pi session", worktreeRoot]);
		worktreeLocked = true;
		const manifest: SessionManifest = {
			version: 1,
			id,
			repoRoot,
			commonGitDir,
			worktreeRoot,
			launchCwdRelative: record.launchCwdRelative,
			sessionHubCwd: record.sessionHubCwd,
			agentDir: record.agentDir,
			targetBranch: record.targetBranch,
			targetRef: record.targetRef,
			baseSha: startSha,
			publishedHead: startSha,
			copiedEnvFiles,
			createdAt: new Date().toISOString(),
			manifestPath,
		};
		await saveManifest(manifest);
		const childCwd = path.join(worktreeRoot, record.launchCwdRelative);
		await fs.promises.mkdir(childCwd, { recursive: true });
		await linkSessionDirectory(childCwd, record.sessionHubCwd, record.agentDir);
		return { manifest, childCwd };
	} catch (error) {
		await fs.promises.rm(manifestPath, { force: true }).catch(() => undefined);
		if (worktreeLocked) await git(repoRoot, ["worktree", "unlock", worktreeRoot]).catch(() => undefined);
		if (worktreeAdded) await git(repoRoot, ["worktree", "remove", "--force", worktreeRoot]).catch(() => undefined);
		throw error;
	}
}

export async function releaseManagedWorktree(manifest: SessionManifest): Promise<void> {
	await assertWorktreeReleasable(manifest);
	await cleanCopiedEnvFiles(manifest);
	await git(manifest.repoRoot, ["worktree", "unlock", manifest.worktreeRoot]);
	try {
		await git(manifest.repoRoot, ["worktree", "remove", "--force", manifest.worktreeRoot]);
	} catch (error) {
		await git(manifest.repoRoot, ["worktree", "lock", "--reason", "active Pi session", manifest.worktreeRoot]).catch(
			() => undefined,
		);
		throw error;
	}
	const cleanup = await Promise.allSettled([
		git(manifest.repoRoot, ["update-ref", "-d", `refs/pi-worktree-snapshots/${manifest.id}/working`]),
		git(manifest.repoRoot, ["update-ref", "-d", `refs/pi-worktree-snapshots/${manifest.id}/index`]),
		fs.promises.rm(manifest.manifestPath, { force: true }),
	]);
	for (const result of cleanup) {
		if (result.status === "rejected") {
			const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
			process.stderr.write(`Pi worktree isolation: post-release metadata cleanup failed: ${message}\n`);
		}
	}
}

async function currentBranch(cwd: string): Promise<string | null> {
	const branch = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
	return branch || null;
}

async function hasInProgressOperation(manifest: SessionManifest): Promise<boolean> {
	const gitDirRaw = await git(manifest.worktreeRoot, ["rev-parse", "--git-dir"]);
	const gitDir = resolveGitPath(manifest.worktreeRoot, gitDirRaw);
	return ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"].some(
		(name) => fs.existsSync(path.join(gitDir, name)),
	);
}

async function hasRebaseState(manifest: SessionManifest): Promise<boolean> {
	const gitDirRaw = await git(manifest.worktreeRoot, ["rev-parse", "--git-dir"]);
	const gitDir = resolveGitPath(manifest.worktreeRoot, gitDirRaw);
	return fs.existsSync(path.join(gitDir, "rebase-merge")) || fs.existsSync(path.join(gitDir, "rebase-apply"));
}

async function acquirePublishLock(commonGitDir: string): Promise<() => Promise<void>> {
	const lockDir = path.join(commonGitDir, "pi-worktree-publish.lock");
	const token = randomUUID();
	for (let attempt = 0; attempt < 200; attempt++) {
		const candidate = `${lockDir}.${process.pid}.${token}`;
		await fs.promises.rm(candidate, { recursive: true, force: true });
		await fs.promises.mkdir(candidate);
		await fs.promises.writeFile(
			path.join(candidate, "owner.json"),
			`${JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })}\n`,
			"utf8",
		);
		try {
			// The fully initialized directory becomes visible in one rename.
			await fs.promises.rename(candidate, lockDir);
			return async () => {
				const ownerText = await fs.promises.readFile(path.join(lockDir, "owner.json"), "utf8").catch(() => "");
				let ownerToken: string;
				try {
					ownerToken = String((JSON.parse(ownerText) as { token?: unknown }).token ?? "");
				} catch {
					return;
				}
				if (ownerToken === token) await fs.promises.rm(lockDir, { recursive: true, force: true });
			};
		} catch (error) {
			await fs.promises.rm(candidate, { recursive: true, force: true });
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
			const ownerText = await fs.promises.readFile(path.join(lockDir, "owner.json"), "utf8").catch(() => "");
			let owner = 0;
			try {
				owner = Number((JSON.parse(ownerText) as { pid?: unknown }).pid ?? 0);
			} catch {
				// A malformed lock is never reaped automatically: safety beats liveness.
			}
			if (owner > 0) {
				try {
					process.kill(owner, 0);
				} catch {
					throw new Error(`Stale Pi publication lock at ${lockDir}; remove it after confirming PID ${owner} is gone.`);
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	throw new Error("Timed out waiting for another Pi session to publish Git changes.");
}

interface WorktreeEntry {
	path: string;
	branch?: string;
}

async function listWorktrees(repoRoot: string): Promise<WorktreeEntry[]> {
	const output = await git(repoRoot, ["worktree", "list", "--porcelain"]);
	const worktrees: WorktreeEntry[] = [];
	for (const block of output.split("\n\n")) {
		const lines = block.split("\n");
		const pathLine = lines.find((line) => line.startsWith("worktree "));
		if (!pathLine) continue;
		const branchLine = lines.find((line) => line.startsWith("branch "));
		const entry: WorktreeEntry = { path: pathLine.slice("worktree ".length) };
		if (branchLine) entry.branch = branchLine.slice("branch refs/heads/".length);
		worktrees.push(entry);
	}
	return worktrees;
}

function nulPaths(output: string): Set<string> {
	return new Set(
		output
			.split("\0")
			.filter(Boolean)
			.map((relativePath) => relativePath.replace(/\/$/, "")),
	);
}

function findPathCollision(incoming: Set<string>, existing: Set<string>): string | null {
	for (const added of incoming) {
		for (const present of existing) {
			if (added === present || added.startsWith(`${present}/`) || present.startsWith(`${added}/`)) return added;
		}
	}
	return null;
}

async function checkoutTransitionProblem(
	holderPath: string,
	oldHead: string,
	newHead: string,
	expectedDirtyTree?: string,
	expectedDirtyBase?: string,
	expectedIndexTree?: string,
): Promise<string | null> {
	if (expectedDirtyTree && expectedDirtyBase) {
		const current = await workingTreeSnapshot(holderPath, expectedDirtyBase);
		if (current.tree !== expectedDirtyTree) return "the launch checkout changed after its automatic snapshot";
		if (expectedIndexTree && (await indexTreeSnapshot(holderPath)) !== expectedIndexTree) {
			return "the launch checkout index changed after its automatic snapshot";
		}
		const added = nulPaths(await git(holderPath, ["diff", "--name-only", "--diff-filter=A", "-z", oldHead, newHead]));
		const ignored = nulPaths(
			await git(holderPath, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]),
		);
		const ignoredCollision = findPathCollision(added, ignored);
		return ignoredCollision ? `the incoming tracked path ${ignoredCollision} collides with an ignored path` : null;
	}

	const indexTree = await indexTreeSnapshot(holderPath);
	const oldTree = await git(holderPath, ["rev-parse", `${oldHead}^{tree}`]);
	if (indexTree !== oldTree) return "its index changed after the publication pre-check";
	const worktreeDiff = await run(holderPath, ["diff", "--quiet"]);
	if (worktreeDiff.code === 1) return "its tracked files changed after the publication pre-check";
	if (worktreeDiff.code !== 0) return `Git could not inspect its tracked files: ${worktreeDiff.stderr.trim()}`;

	const added = nulPaths(await git(holderPath, ["diff", "--name-only", "--diff-filter=A", "-z", oldHead, newHead]));
	if (added.size === 0) return null;
	const untracked = nulPaths(
		await git(holderPath, ["ls-files", "--others", "--exclude-standard", "--directory", "-z"]),
	);
	const ignored = nulPaths(
		await git(holderPath, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]),
	);
	const collision = findPathCollision(added, new Set([...untracked, ...ignored]));
	return collision ? `the incoming tracked path ${collision} collides with an untracked or ignored path` : null;
}

async function replaceIndexIfUnchanged(
	holderPath: string,
	newHead: string,
	expectedIndexTree: string,
): Promise<string | null> {
	const indexRaw = await git(holderPath, ["rev-parse", "--git-path", "index"]);
	const indexPath = path.isAbsolute(indexRaw) ? indexRaw : path.resolve(holderPath, indexRaw);
	const nonce = `${process.pid}-${randomUUID()}`;
	const preparedPath = `${indexPath}.pi-prepared-${nonce}`;
	const inspectedPath = `${indexPath}.pi-inspected-${nonce}`;
	const lockPath = `${indexPath}.lock`;
	let lock: fs.promises.FileHandle | null = null;
	try {
		await git(holderPath, ["read-tree", newHead], { GIT_INDEX_FILE: preparedPath });
		try {
			lock = await fs.promises.open(lockPath, "wx");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return "the checkout index is locked by another Git process";
			throw error;
		}
		const original = await fs.promises.stat(indexPath);
		await fs.promises.copyFile(indexPath, inspectedPath);
		const currentTree = await git(holderPath, ["write-tree"], { GIT_INDEX_FILE: inspectedPath });
		if (currentTree !== expectedIndexTree) return "the launch checkout index changed after its automatic snapshot";
		await fs.promises.chmod(preparedPath, original.mode);
		await fs.promises.rename(preparedPath, indexPath);
		return null;
	} finally {
		if (lock) {
			await lock.close();
			await fs.promises.rm(lockPath, { force: true });
		}
		await fs.promises.rm(preparedPath, { force: true });
		await fs.promises.rm(inspectedPath, { force: true });
	}
}

async function synchronizeDirtySnapshot(holderPath: string, pending: PendingSync): Promise<string | null> {
	if (
		!pending.expectedDirtyTree ||
		!pending.expectedDirtyBase ||
		!pending.expectedDirtyCommit ||
		!pending.expectedIndexTree ||
		!pending.expectedIndexCommit
	) {
		return "the dirty-checkout recovery record is incomplete";
	}
	const newTree = await git(holderPath, ["rev-parse", `${pending.newHead}^{tree}`]);
	const indexTree = await indexTreeSnapshot(holderPath);
	if (indexTree === newTree && !(await git(holderPath, ["status", "--porcelain=v1"]))) return null;
	const indexAlreadyTransitioned = indexTree === newTree;

	const problem = await checkoutTransitionProblem(
		holderPath,
		pending.oldHead,
		pending.newHead,
		pending.expectedDirtyTree,
		pending.expectedDirtyBase,
		indexAlreadyTransitioned ? undefined : pending.expectedIndexTree,
	);
	if (problem) return problem;

	const patchPath = path.join(os.tmpdir(), `pi-worktree-transition-${process.pid}-${randomUUID()}.patch`);
	try {
		const createPatch = await run(holderPath, [
			"diff",
			"--binary",
			"--full-index",
			`--output=${patchPath}`,
			pending.expectedDirtyCommit,
			pending.newHead,
		]);
		if (createPatch.code !== 0) return `Git could not prepare the checkout transition: ${createPatch.stderr.trim()}`;
		if (!indexAlreadyTransitioned) {
			const replaceProblem = await replaceIndexIfUnchanged(holderPath, pending.newHead, pending.expectedIndexTree);
			if (replaceProblem) return replaceProblem;
		}
		if ((await fs.promises.stat(patchPath)).size > 0) {
			const apply = await run(holderPath, ["apply", "--binary", patchPath]);
			if (apply.code !== 0) return `working files changed while synchronizing; Git left them intact (${apply.stderr.trim()})`;
		}
		const status = await git(holderPath, ["status", "--porcelain=v1"]);
		return status ? `the checkout still has changes after safe synchronization (${status.split("\n").join(", ")})` : null;
	} finally {
		await fs.promises.rm(patchPath, { force: true });
	}
}

async function recoverPendingSync(manifest: SessionManifest): Promise<EnforcementResult | null> {
	const pending = manifest.pendingSync;
	if (!pending) return null;
	const targetResult = await run(manifest.repoRoot, ["rev-parse", "--verify", `${manifest.targetRef}^{commit}`]);
	if (targetResult.code !== 0) {
		return {
			kind: "blocked",
			message: `Cannot recover publication because ${manifest.targetBranch} no longer exists. The session commit remains safe.`,
		};
	}
	const target = targetResult.stdout.trim();
	if (target === pending.oldHead) {
		delete manifest.pendingSync;
		await saveManifest(manifest);
		return null;
	}
	if (target !== pending.newHead) {
		return {
			kind: "blocked",
			message: `Cannot recover checkout synchronization because ${manifest.targetBranch} moved again. The session commit remains safe.`,
		};
	}

	const holder = (await listWorktrees(manifest.repoRoot)).find((entry) => entry.branch === manifest.targetBranch);
	manifest.publishedHead = pending.newHead;
	if (!holder) {
		delete manifest.pendingSync;
		await saveManifest(manifest);
		return { kind: "ok", message: `Recovered publication to ${manifest.targetBranch}.` };
	}
	if (pending.expectedDirtyTree && pending.expectedDirtyBase) {
		const problem = await synchronizeDirtySnapshot(holder.path, pending);
		if (problem) {
			return {
				kind: "blocked",
				message: `Published to ${manifest.targetBranch}, but cannot safely synchronize ${holder.path}: ${problem}.`,
			};
		}
	} else {
		const newTree = await git(holder.path, ["rev-parse", `${pending.newHead}^{tree}`]);
		const indexTree = await indexTreeSnapshot(holder.path);
		if (indexTree === newTree) {
			const worktreeDiff = await run(holder.path, ["diff", "--quiet"]);
			if (worktreeDiff.code !== 0) {
				return {
					kind: "blocked",
					message: `The ${manifest.targetBranch} index is synchronized, but ${holder.path} still has working-file changes; recovery was preserved.`,
				};
			}
		} else {
			const problem = await checkoutTransitionProblem(holder.path, pending.oldHead, pending.newHead);
			if (problem) {
				return {
					kind: "blocked",
					message: `Published to ${manifest.targetBranch}, but cannot safely synchronize ${holder.path}: ${problem}.`,
				};
			}
			const synchronize = await run(holder.path, ["read-tree", "-u", "-m", pending.oldHead, pending.newHead]);
			if (synchronize.code !== 0) {
				return {
					kind: "blocked",
					message: `Published to ${manifest.targetBranch}, but checkout synchronization is still pending: ${synchronize.stderr.trim()}`,
				};
			}
		}
	}
	delete manifest.pendingSync;
	await saveManifest(manifest);
	return { kind: "ok", message: `Published and synchronized session commit to ${manifest.targetBranch}.` };
}

async function containingBranch(repoRoot: string, commit: string): Promise<string | null> {
	const output = await git(repoRoot, [
		"for-each-ref",
		"--format=%(refname:short)",
		"--contains",
		commit,
		"refs/heads",
		"refs/remotes",
	]);
	return output
		.split("\n")
		.map((ref) => ref.trim())
		.find((ref) => ref && !ref.endsWith("/HEAD")) ?? null;
}

async function publishDetached(manifest: SessionManifest): Promise<EnforcementResult> {
	if (await hasRebaseState(manifest)) {
		return {
			kind: "needs-agent",
			prompt:
				"Git publication is paused in a rebase conflict. Resolve every conflict, stage the resolutions, run `git rebase --continue`, and do not stop until the rebase completes and `git status --porcelain` is empty.",
		};
	}

	const release = await acquirePublishLock(manifest.commonGitDir);
	try {
		const recovered = await recoverPendingSync(manifest);
		if (recovered) return recovered;
		let head = await git(manifest.worktreeRoot, ["rev-parse", "HEAD"]);
		for (let attempt = 0; attempt < 5; attempt++) {
			const targetResult = await run(manifest.repoRoot, ["rev-parse", "--verify", `${manifest.targetRef}^{commit}`]);
			if (targetResult.code !== 0) {
				const containing = await containingBranch(manifest.repoRoot, head);
				if (containing) {
					manifest.publishedHead = head;
					await saveManifest(manifest);
					return {
						kind: "ok",
						message: `Session commit ${head.slice(0, 8)} is already contained in ${containing}; launch branch ${manifest.targetBranch} was removed.`,
					};
				}
				return {
					kind: "blocked",
					message: `Cannot publish this session because its launch branch ${manifest.targetBranch} no longer exists. The commit remains safe in ${manifest.worktreeRoot}.`,
				};
			}
			const target = targetResult.stdout.trim();
			if (head === target) {
				manifest.publishedHead = head;
				await saveManifest(manifest);
				return { kind: "ok" };
			}
			if (head === manifest.publishedHead) return { kind: "ok" };

			const targetIsAncestor =
				(await run(manifest.worktreeRoot, ["merge-base", "--is-ancestor", target, head])).code === 0;
			if (!targetIsAncestor) {
				const rebase = await run(manifest.worktreeRoot, ["rebase", target]);
				if (rebase.code !== 0) {
					return {
						kind: "needs-agent",
						prompt: `The launch branch ${manifest.targetBranch} advanced and Git found conflicts while rebasing this session. Resolve every conflict, stage the resolutions, run \`git rebase --continue\`, and continue until the rebase completes. Do not abort the rebase.`,
					};
				}
				head = await git(manifest.worktreeRoot, ["rev-parse", "HEAD"]);
			}

			const holder = (await listWorktrees(manifest.repoRoot)).find(
				(entry) => entry.branch === manifest.targetBranch,
			);
			let expectedDirtyTree: string | undefined;
			let expectedDirtyBase: string | undefined;
			let expectedDirtyCommit: string | undefined;
			let expectedIndexTree: string | undefined;
			let expectedIndexCommit: string | undefined;
			if (holder) {
				const holderBranch = await git(holder.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(
					() => "",
				);
				const holderHead = await git(holder.path, ["rev-parse", "HEAD"]);
				if (holderBranch !== manifest.targetBranch || holderHead !== target) continue;
				if (
					path.resolve(holder.path) === path.resolve(manifest.repoRoot) &&
					manifest.launchSnapshotTree &&
					manifest.launchSnapshotCommit &&
					manifest.launchIndexTree &&
					manifest.launchIndexCommit
				) {
					expectedDirtyTree = manifest.launchSnapshotTree;
					expectedDirtyBase = manifest.baseSha;
					expectedDirtyCommit = manifest.launchSnapshotCommit;
					expectedIndexTree = manifest.launchIndexTree;
					expectedIndexCommit = manifest.launchIndexCommit;
				}
				const problem = await checkoutTransitionProblem(
					holder.path,
					target,
					head,
					expectedDirtyTree,
					expectedDirtyBase,
					expectedIndexTree,
				);
				if (problem) {
					return {
						kind: "blocked",
						message: `Cannot publish to ${manifest.targetBranch}: ${holder.path} is unsafe to update because ${problem}.`,
					};
				}
			}

			// Persist the transition before CAS. If the process dies after moving
			// the ref, the next run can safely resume index/worktree synchronization.
			manifest.pendingSync = {
				oldHead: target,
				newHead: head,
				...(expectedDirtyTree &&
				expectedDirtyBase &&
				expectedDirtyCommit &&
				expectedIndexTree &&
				expectedIndexCommit
					? {
							expectedDirtyTree,
							expectedDirtyBase,
							expectedDirtyCommit,
							expectedIndexTree,
							expectedIndexCommit,
						}
					: {}),
			};
			await saveManifest(manifest);
			const update = await run(manifest.repoRoot, ["update-ref", manifest.targetRef, head, target]);
			if (update.code !== 0) {
				delete manifest.pendingSync;
				await saveManifest(manifest);
				continue;
			}

			manifest.publishedHead = head;
			await saveManifest(manifest);
			return (
				(await recoverPendingSync(manifest)) ?? {
					kind: "ok",
					message: `Published session commit ${head.slice(0, 8)} to ${manifest.targetBranch}.`,
				}
			);
		}
		return {
			kind: "blocked",
			message: `${manifest.targetBranch} kept changing during publication. The session commit remains safe for a later retry.`,
		};
	} finally {
		await release();
	}
}

export async function enforceRepository(manifest: SessionManifest): Promise<EnforcementResult> {
	if (await hasRebaseState(manifest)) {
		return {
			kind: "needs-agent",
			prompt:
				"Git publication is paused in a rebase conflict. Resolve every conflict, stage the resolutions, run `git rebase --continue`, and do not stop until the rebase completes and `git status --porcelain` is empty.",
		};
	}
	const status = await git(manifest.worktreeRoot, ["status", "--porcelain=v1"]);
	if (status) {
		return {
			kind: "needs-agent",
			prompt:
				"This isolated Pi worktree still has uncommitted changes. Review them and commit all intended work with an appropriate Conventional Commit message. Do not stop until `git status --porcelain` is empty. If the task should use a feature branch, create or switch to that named branch before committing.",
		};
	}

	const branch = await currentBranch(manifest.worktreeRoot);
	if (branch) {
		const head = await git(manifest.worktreeRoot, ["rev-parse", "HEAD"]);
		manifest.targetBranch = branch;
		manifest.targetRef = `refs/heads/${branch}`;
		manifest.publishedHead = head;
		await saveManifest(manifest);
		return { kind: "ok", message: `Work remains on agent-selected branch ${branch}.` };
	}
	return publishDetached(manifest);
}
