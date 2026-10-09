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
	/** Branch explicitly created by isolated_new_branch; only this branch is eligible for cleanup. */
	createdBranch?: string;
	baseSha: string;
	publishedHead: string;
	launchSnapshotCommit?: string;
	launchSnapshotTree?: string;
	launchIndexTree?: string;
	launchIndexCommit?: string;
	pendingSync?: PendingSync;
	copiedEnvFiles?: string[]; // Legacy manifests created before ignored paths were linked.
	linkedIgnoredPaths?: string[];
	createdAt: string;
	manifestPath: string;
	ownerPid?: number;
}

export interface SessionResumeRecord {
	version: 1;
	sessionFile: string;
	repoRoot: string;
	commonGitDir: string;
	launchCwdRelative: string;
	/** Original cwd for this transcript, which may be nested below the launch cwd. */
	sessionCwdRelative?: string;
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

function linkedPath(relativePath: string): string {
	return relativePath.replace(/\/$/, ""); // Git prints ignored directories with a trailing slash.
}

function isDisposableCoverage(relativePath: string): boolean {
	return path.basename(relativePath) === ".coverage";
}

type LinkedPaths = Pick<SessionManifest, "repoRoot" | "worktreeRoot" | "linkedIgnoredPaths">;

async function verifyKnownLinks(manifest: LinkedPaths): Promise<void> {
	// Check every path before unlinking any: replaced links and generated files belong to the session.
	for (const relativePath of manifest.linkedIgnoredPaths ?? []) {
		const destination = path.join(manifest.worktreeRoot, relativePath);
		let stat: fs.Stats;
		try {
			stat = await fs.promises.lstat(destination);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (!stat.isSymbolicLink() || (await fs.promises.readlink(destination)) !== path.join(manifest.repoRoot, relativePath)) {
			// A branch change can turn an ignored linked directory into a tracked
			// directory. It belongs to Git now, so never unlink or relocate it.
			if ((await git(manifest.worktreeRoot, ["ls-files", "--", relativePath])).trim()) continue;
			// Older sessions linked .coverage; coverage tools replace that link with a disposable file.
			if (isDisposableCoverage(relativePath) && stat.isFile()) continue;
			throw new Error(`Linked ignored path ${relativePath} was replaced; worktree was preserved.`);
		}
	}
}

async function removeKnownLinks(manifest: LinkedPaths): Promise<void> {
	await verifyKnownLinks(manifest);
	for (const relativePath of manifest.linkedIgnoredPaths ?? []) {
		const destination = path.join(manifest.worktreeRoot, relativePath);
		const stat = await fs.promises.lstat(destination).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (stat?.isSymbolicLink() && (await fs.promises.readlink(destination)) === path.join(manifest.repoRoot, relativePath)) {
			await fs.promises.unlink(destination);
		}
	}
}

async function removeDisposableCoverage(manifest: SessionManifest): Promise<void> {
	for (const relativePath of await listIgnoredPaths(manifest.worktreeRoot)) {
		if (!isDisposableCoverage(relativePath) || (manifest.linkedIgnoredPaths ?? []).includes(relativePath)) continue;
		const destination = path.join(manifest.worktreeRoot, relativePath);
		const stat = await fs.promises.lstat(destination);
		if (stat.isFile()) await fs.promises.unlink(destination);
	}
}

function excludePattern(relativePath: string): string {
	// Anchor to the worktree root; quote Git wildmatch metacharacters and spaces.
	return `/${relativePath.replace(/[\\*?[\]#! ]/g, "\\$&")}\n`;
}

async function enableWorktreeConfig(repoRoot: string): Promise<void> {
	if ((await git(repoRoot, ["config", "--local", "--get", "extensions.worktreeConfig"]).catch(() => "")) === "true") return;
	// Repository-wide switch, but the exclusion setting itself is private to each worktree.
	for (let attempt = 0; attempt < 10; attempt++) {
		const result = await run(repoRoot, ["config", "--local", "extensions.worktreeConfig", "true"]);
		if (result.code === 0) return;
		if (!result.stderr.includes("lock") || attempt === 9) throw new Error(result.stderr);
		await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
	}
}

async function configureLinkedExcludes(repoRoot: string, worktreeRoot: string, paths: string[]): Promise<void> {
	await enableWorktreeConfig(repoRoot);
	const privateGitDir = await git(worktreeRoot, ["rev-parse", "--absolute-git-dir"]);
	const excludesFile = path.join(privateGitDir, "pi-linked-ignored-excludes");
	// core.excludesFile replaces the user's global file; carry its patterns forward.
	const configuredFile = await git(repoRoot, ["config", "--path", "--get", "core.excludesFile"]).catch(() => "");
	const globalFile = configuredFile
		? path.resolve(repoRoot, configuredFile)
		: path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "git", "ignore");
	const globalPatterns = await fs.promises.readFile(globalFile, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return "";
		throw error;
	});
	await fs.promises.writeFile(
		excludesFile,
		`${globalPatterns}${globalPatterns && !globalPatterns.endsWith("\n") ? "\n" : ""}${paths.map(excludePattern).join("")}`,
	);
	await git(worktreeRoot, ["config", "--worktree", "core.excludesFile", excludesFile]);
}

async function listIgnoredPaths(repoRoot: string): Promise<string[]> {
	const ignored = await git(repoRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
	const candidates: string[] = [];
	for (const entry of ignored.split("\0").filter(Boolean)) {
		// --directory also prints containers that merely hold ignored files. Linking
		// those would hide future non-ignored files from the worktree's Git index.
		if (entry.endsWith("/")) {
			const result = await run(repoRoot, ["check-ignore", "--quiet", "--no-index", "--", entry]);
			if (result.code === 1) continue;
			if (result.code !== 0) throw new Error(result.stderr);
		}
		candidates.push(linkedPath(entry));
	}
	return candidates;
}

// Build outputs and dependency/cache directories must be private to each
// session. Linking them makes new worktrees look like they contain copies of
// old sessions' artifacts (including names relocated on earlier releases).
function isGeneratedDirectory(relativePath: string): boolean {
	return relativePath.split(path.sep).some((part) =>
		/^(?:node_modules|\.venv|venv|__pycache__|\.next|dist|build|(?:\.?[\w.-]*cache))(?:-[a-z]+-[a-z]+(?:-\d+)?)*$/i.test(part),
	);
}

async function linkIgnoredPaths(repoRoot: string, worktreeRoot: string): Promise<string[]> {
	const candidates = (await listIgnoredPaths(repoRoot)).filter((relativePath) => !isDisposableCoverage(relativePath));
	const linked: string[] = [];
	try {
		// Configure before linking so even directory-only ignore rules cannot expose links to Git.
		await configureLinkedExcludes(repoRoot, worktreeRoot, candidates);
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
			if (!sourceStat.isFile() && !sourceStat.isDirectory() && !sourceStat.isSymbolicLink()) continue;
			if (isGeneratedDirectory(relativePath) &&
				(sourceStat.isDirectory() || (sourceStat.isSymbolicLink() &&
					(await fs.promises.stat(source).catch(() => null))?.isDirectory()))) continue;
			try {
				await fs.promises.lstat(destination);
				continue; // Never replace tracked or session-owned content.
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			await fs.promises.mkdir(path.dirname(destination), { recursive: true });
			await fs.promises.symlink(source, destination);
			linked.push(relativePath);
		}
		return linked;
	} catch (error) {
		await removeKnownLinks({ repoRoot, worktreeRoot, linkedIgnoredPaths: linked });
		throw error;
	}
}

export async function hydrateIgnoredPaths(manifest: SessionManifest): Promise<void> {
	await removeKnownLinks(manifest);
	await removeEnvFiles(manifest.worktreeRoot, manifest.copiedEnvFiles ?? []);
	manifest.linkedIgnoredPaths = await linkIgnoredPaths(manifest.repoRoot, manifest.worktreeRoot);
	manifest.copiedEnvFiles = [];
	await saveManifest(manifest);
}

export async function cleanLinkedIgnoredPaths(manifest: SessionManifest): Promise<void> {
	await removeKnownLinks(manifest);
	await removeDisposableCoverage(manifest);
	await removeEnvFiles(manifest.worktreeRoot, manifest.copiedEnvFiles ?? []);
	manifest.linkedIgnoredPaths = [];
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

async function reserveSessionId(commonGitDir: string, worktreesRoot: string): Promise<string> {
	await fs.promises.mkdir(manifestDirectory(commonGitDir), { recursive: true });
	for (let attempt = 0; attempt < 100; attempt++) {
		const base = `${ADJECTIVES[randomInt(ADJECTIVES.length)]}-${NOUNS[randomInt(NOUNS.length)]}`;
		const id = attempt < 20 ? base : `${base}-${randomInt(1000, 10000)}`;
		if (fs.existsSync(path.join(worktreesRoot, id))) continue;
		try {
			const handle = await fs.promises.open(path.join(manifestDirectory(commonGitDir), `${id}.json`), "wx");
			await handle.close();
			return id;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	throw new Error("Could not reserve a unique Pi worktree name.");
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

	return writeResumeCheckpoint(manifest, sessionFile, await git(manifest.worktreeRoot, ["rev-parse", "HEAD"]));
}

async function writeResumeCheckpoint(manifest: SessionManifest, sessionFile: string, resumeSha: string): Promise<SessionResumeRecord> {
	const resolvedSessionFile = await canonicalSessionFilePath(sessionFile);
	const existing = await loadResumeRecord(resolvedSessionFile);
	if (existing) {
		const cwd = await sessionCwd(resolvedSessionFile);
		const protectedSha = await git(manifest.repoRoot, ["rev-parse", "--verify", existing.resumeRef]);
		if (existing.commonGitDir !== manifest.commonGitDir || existing.resumeSha !== resumeSha ||
			protectedSha !== resumeSha || !cwd ||
			(cwd !== existing.placeholderCwd && cwd !== path.resolve(manifest.worktreeRoot, manifest.launchCwdRelative))) {
			throw new Error(`Existing resume checkpoint for ${sessionFile} does not match this worktree.`);
		}
		if (cwd !== existing.placeholderCwd) await rewriteSessionCwd(resolvedSessionFile, existing.placeholderCwd);
		return existing;
	}
	const key = createHash("sha256").update(resolvedSessionFile).digest("hex").slice(0, 24);
	const resumeRef = `refs/pi-worktree-sessions/${key}`;
	const agentDir = inferredAgentDir(manifest);
	const placeholderCwd = path.join(agentDir, "released-sessions", key);
	const originalCwd = await sessionCwd(resolvedSessionFile);
	const relativeCwd = originalCwd ? path.relative(manifest.worktreeRoot, originalCwd) : manifest.launchCwdRelative;
	if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
		throw new Error(`Session cwd is outside its worktree: ${resolvedSessionFile}`);
	}
	const record: SessionResumeRecord = {
		version: 1,
		sessionFile: resolvedSessionFile,
		repoRoot: manifest.repoRoot,
		commonGitDir: manifest.commonGitDir,
		launchCwdRelative: manifest.launchCwdRelative,
		sessionCwdRelative: relativeCwd,
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

async function checkpointOrphanedSessions(manifest: SessionManifest): Promise<void> {
	if (manifest.pendingSync) throw new Error("Cannot recover an orphaned worktree while checkout synchronization is pending.");
	await git(manifest.repoRoot, ["cat-file", "-e", `${manifest.publishedHead}^{commit}`]);
	const sessionDir = sessionDirectoryForCwd(manifest.sessionHubCwd ?? manifest.repoRoot, inferredAgentDir(manifest));
	for (const entry of await fs.promises.readdir(sessionDir, { withFileTypes: true }).catch(() => [])) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		const sessionFile = path.join(sessionDir, entry.name);
		const cwd = await sessionCwd(sessionFile);
		if (cwd !== manifest.worktreeRoot && !cwd?.startsWith(`${manifest.worktreeRoot}${path.sep}`)) continue;
		await writeResumeCheckpoint(manifest, sessionFile, manifest.publishedHead);
	}
}

export async function checkpointSessionIfPresent(
	manifest: SessionManifest,
	sessionFile: string,
): Promise<SessionResumeRecord | null> {
	const existing = await fs.promises.lstat(sessionFile).catch(() => null);
	if (!existing?.isFile()) return null;
	return checkpointSession(manifest, sessionFile);
}

// Unknown ignored outputs are not published and must remain in their worktree.
// Refuse release rather than silently deleting or moving experiment results.
export async function assertWorktreeReleasable(manifest: SessionManifest): Promise<void> {
	if (manifest.pendingSync) throw new Error("Checkout synchronization is still pending.");
	if (await hasInProgressOperation(manifest)) throw new Error("A Git operation is still in progress.");
	if (await git(manifest.worktreeRoot, ["status", "--porcelain=v1"])) {
		throw new Error("The managed worktree is not clean.");
	}
	const ignored = await listIgnoredPaths(manifest.worktreeRoot);
	await verifyKnownLinks(manifest);
	const ephemeral = new Set([...(manifest.copiedEnvFiles ?? []), ...(manifest.linkedIgnoredPaths ?? [])]);
	for (const relativePath of ignored) {
		if (ephemeral.has(relativePath)) continue;
		if (isDisposableCoverage(relativePath)) {
			const stat = await fs.promises.lstat(path.join(manifest.worktreeRoot, relativePath));
			if (stat.isFile()) continue;
		}
		throw new Error(`Ignored path ${relativePath} is not ephemeral session configuration; worktree was preserved.`);
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

export async function createLaunchPlan(cwd: string, agentDir?: string, newBranch?: string): Promise<LaunchPlan> {
	const repoRoot = await findRepoRoot(cwd);
	if (!repoRoot) throw new Error(`${cwd} is not inside a Git working tree.`);
	if (newBranch !== undefined) {
		if (!newBranch || (await run(repoRoot, ["check-ref-format", "--branch", newBranch])).code !== 0) {
			throw new Error(`Invalid branch name: ${newBranch}`);
		}
		if ((await run(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${newBranch}`])).code === 0) {
			throw new Error(`Branch ${newBranch} already exists.`);
		}
		if (await git(repoRoot, ["status", "--porcelain=v1"])) {
			throw new Error("Commit or remove non-ignored checkout changes before creating an isolated branch.");
		}
	}

	let targetBranch = "";
	let baseSha = "";
	let snapshot: LaunchSnapshot | null = null;
	for (let attempt = 0; attempt < 10; attempt++) {
		targetBranch = await git(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
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
	if (newBranch && (snapshot.workingTree || await git(repoRoot, ["status", "--porcelain=v1"]))) {
		throw new Error("The checkout changed while preparing the isolated branch; retry from a clean checkout.");
	}
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
	const id = await reserveSessionId(commonGitDir, worktreesRoot);
	// A detached launch has no safe publication target. Give this session its
	// own branch rather than guessing or changing another worktree's branch.
	const detachedLaunch = !targetBranch && !newBranch;
	if (newBranch) targetBranch = newBranch;
	else if (detachedLaunch) targetBranch = `pi/${id}`;
	const requestedWorktreeRoot = path.join(worktreesRoot, id);
	await fs.promises.mkdir(worktreesRoot, { recursive: true });
	const hasSnapshotRefs = Boolean(snapshot.workingTree && snapshot.indexCommit);
	const manifestPath = path.join(manifestDirectory(commonGitDir), `${id}.json`);
	let worktreeRoot = requestedWorktreeRoot;
	let worktreeAdded = false;
	let worktreeLocked = false;
	let workingRefCreated = false;
	let indexRefCreated = false;
	let targetRefCreated = false;
	try {
		if (detachedLaunch) {
			await git(repoRoot, ["update-ref", `refs/heads/${targetBranch}`, snapshot.startSha, "0000000000000000000000000000000000000000"]);
			targetRefCreated = true;
		}
		if (hasSnapshotRefs) {
			await git(repoRoot, ["update-ref", `refs/pi-worktree-snapshots/${id}/working`, snapshot.startSha]);
			workingRefCreated = true;
			await git(repoRoot, ["update-ref", `refs/pi-worktree-snapshots/${id}/index`, snapshot.indexCommit!]);
			indexRefCreated = true;
		}
		await git(repoRoot, newBranch
			? ["worktree", "add", "-b", newBranch, requestedWorktreeRoot, snapshot.startSha]
			: ["worktree", "add", "--detach", requestedWorktreeRoot, snapshot.startSha]);
		if (newBranch) targetRefCreated = true;
		worktreeAdded = true;
		worktreeRoot = await fs.promises.realpath(requestedWorktreeRoot);
		const linkedIgnoredPaths = await linkIgnoredPaths(repoRoot, worktreeRoot);
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
			...(newBranch ? { createdBranch: newBranch } : {}),
			baseSha,
			publishedHead: detachedLaunch || newBranch ? snapshot.startSha : baseSha,
			...(snapshot.workingTree && snapshot.indexTree && snapshot.indexCommit
				? {
						launchSnapshotCommit: snapshot.startSha,
						launchSnapshotTree: snapshot.workingTree,
						launchIndexTree: snapshot.indexTree,
						launchIndexCommit: snapshot.indexCommit,
					}
				: {}),
			linkedIgnoredPaths,
			createdAt: new Date().toISOString(),
			manifestPath,
			ownerPid: process.pid,
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
		if (targetRefCreated && !cleanupFailures.length) {
			await attemptCleanup("new session branch removal", () =>
				git(repoRoot, ["update-ref", "-d", `refs/heads/${targetBranch}`, snapshot.startSha]),
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
	const id = await reserveSessionId(commonGitDir, worktreesRoot);
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
		const linkedIgnoredPaths = await linkIgnoredPaths(repoRoot, worktreeRoot);
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
			linkedIgnoredPaths,
			createdAt: new Date().toISOString(),
			manifestPath,
			ownerPid: process.pid,
		};
		await saveManifest(manifest);
		const childCwd = path.join(worktreeRoot, record.sessionCwdRelative ?? record.launchCwdRelative);
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

export async function claimManagedWorktree(manifest: SessionManifest): Promise<void> {
	manifest.ownerPid = process.pid;
	await saveManifest(manifest);
}

// A killed Pi cannot run session_shutdown. Its next parent invocation (or the
// next Pi started in this repository) performs the same safe release instead.
export async function reapStaleWorktrees(repoRoot: string, finishedChildPid?: number): Promise<string[]> {
	repoRoot = await fs.promises.realpath(repoRoot);
	const commonRaw = await git(repoRoot, ["rev-parse", "--git-common-dir"]);
	const commonGitDir = resolveGitPath(repoRoot, commonRaw);
	const dir = manifestDirectory(commonGitDir);
	const released: string[] = [];
	const entries = await fs.promises.readdir(dir).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	if (!entries.length) return released;
	let unlock: (() => Promise<void>) | undefined;
	try {
		unlock = await acquireFileLease(path.join(commonGitDir, "pi-worktree-reaper.lock"), "Pi worktree reaper");
	} catch (error) {
		if (error instanceof Error && error.message.includes("already active")) return released;
		throw error;
	}
	try {
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;
			try {
				const manifest = await loadManifest(path.join(dir, entry));
				const managedRoot = await fs.promises.realpath(path.join(inferredAgentDir(manifest), "worktrees"));
				if (manifest.commonGitDir !== commonGitDir || !manifest.worktreeRoot.startsWith(managedRoot + path.sep)) continue;
				if (manifest.ownerPid && manifest.ownerPid !== finishedChildPid &&
					!(finishedChildPid && manifest.ownerPid === process.pid) && processIsAlive(manifest.ownerPid)) continue;
				if (!manifest.ownerPid && Date.now() - Date.parse(manifest.createdAt) < 90_000) continue;
				const sessionDir = sessionDirectoryForCwd(manifest.sessionHubCwd ?? manifest.repoRoot, inferredAgentDir(manifest));
				let active = false;
				for (const name of await fs.promises.readdir(sessionDir).catch(() => [])) {
					if (!name.endsWith(".jsonl")) continue;
					const sessionFile = path.join(sessionDir, name);
					const cwd = await sessionCwd(sessionFile);
					if (!cwd || (cwd !== manifest.worktreeRoot && !cwd.startsWith(manifest.worktreeRoot + path.sep))) continue;
					const lock = await fs.promises.readFile(`${sessionFile}.pi-worktree.lock`, "utf8").catch(() => "");
					if (lock) {
						let pid = 0;
						try { pid = Number((JSON.parse(lock) as { pid?: number }).pid); } catch { active = true; }
						if (pid && processIsAlive(pid)) active = true;
					}
				}
				if (active) continue;
				if (!(await fs.promises.lstat(manifest.worktreeRoot).catch(() => null))) {
					// Older releases could remove the Git worktree but leave its manifest
					// and transcripts behind. Restore resumability from the published ref.
					if ((await listWorktrees(manifest.repoRoot)).some((worktree) => worktree.path === manifest.worktreeRoot)) continue;
					await checkpointOrphanedSessions(manifest);
					await git(manifest.repoRoot, ["update-ref", "-d", `refs/pi-worktree-snapshots/${manifest.id}/working`]);
					await git(manifest.repoRoot, ["update-ref", "-d", `refs/pi-worktree-snapshots/${manifest.id}/index`]);
					await fs.promises.rm(manifest.manifestPath, { force: true });
					continue;
				}
				// Explicitly created feature branches survive quit/crash until their
				// changes are verified on main and the cleanup tool is invoked.
				if (manifest.createdBranch) continue;
				if ((await enforceRepository(manifest)).kind !== "ok") continue;
				await assertWorktreeReleasable(manifest);
				await checkpointWorktreeSessions(manifest);
				await releaseManagedWorktree(manifest);
				released.push(manifest.worktreeRoot);
			} catch (error) {
				// Recovery is best-effort. A stale or unsafe worktree must not keep
				// interrupting every new Pi session with the same diagnostic.
				if (process.env.PI_WORKTREE_DEBUG === "1") {
					process.stderr.write(`Pi worktree isolation: preserved ${entry}: ${error instanceof Error ? error.message : String(error)}\n`);
				}
			}
		}
	} finally {
		await unlock();
	}
	return released;
}

/** Fetch main, fast-forward its checkout when safe, and prove this branch adds no missing changes. */
export async function prepareBranchCleanup(manifest: SessionManifest): Promise<{ mainRoot: string; branchSha: string; branchExists: boolean }> {
	const branch = manifest.createdBranch ?? manifest.targetBranch;
	if (!branch || branch === "main" || (!manifest.createdBranch && manifest.targetRef !== `refs/heads/${branch}`)) {
		throw new Error("Cleanup requires a managed feature worktree with a recorded branch.");
	}
	const branchExists = (await run(manifest.repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
	if (branchExists && !manifest.createdBranch) {
		throw new Error("Cleanup cannot delete a branch that was not created by isolated_new_branch.");
	}
	const checkedOut = await currentBranch(manifest.worktreeRoot);
	if (checkedOut !== (branchExists ? branch : null)) {
		throw new Error("Cleanup requires the original isolated branch, or a detached managed worktree after that branch was deleted.");
	}
	await assertWorktreeReleasable(manifest);
	const main = (await listWorktrees(manifest.repoRoot)).find((worktree) => worktree.branch === "main");
	if (!main || main.path === manifest.worktreeRoot) throw new Error("A separate main worktree must be available for cleanup.");
	const mainRoot = await fs.promises.realpath(main.path);
	const branchSha = await git(manifest.worktreeRoot, ["rev-parse", "HEAD"]);
	if (branchExists && branchSha !== await git(manifest.repoRoot, ["rev-parse", `refs/heads/${branch}`])) {
		throw new Error("The isolated branch moved unexpectedly; retry cleanup.");
	}
	if ((await run(manifest.repoRoot, ["remote", "get-url", "origin"])).code === 0) {
		const remoteMain = await run(mainRoot, ["ls-remote", "--exit-code", "--heads", "origin", "main"]);
		if (remoteMain.code !== 0 && remoteMain.code !== 2) {
			throw new Error(`Could not check origin/main: ${remoteMain.stderr.trim()}`);
		}
		if (remoteMain.code === 0) {
			await git(mainRoot, ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
			const remoteSha = await git(mainRoot, ["rev-parse", "refs/remotes/origin/main"]);
			const localSha = await git(mainRoot, ["rev-parse", "refs/heads/main"]);
			if (localSha !== remoteSha && (await run(mainRoot, ["merge-base", "--is-ancestor", remoteSha, localSha])).code !== 0) {
				if ((await run(mainRoot, ["merge-base", "--is-ancestor", localSha, remoteSha])).code !== 0) {
					throw new Error("Local main and origin/main diverged; reconcile them before cleanup.");
				}
				if (await git(mainRoot, ["status", "--porcelain=v1"])) {
					throw new Error("Local main has uncommitted changes and cannot be fast-forwarded safely.");
				}
				await git(mainRoot, ["merge", "--ff-only", "refs/remotes/origin/main"]);
			}
		}
	}
	const mainSha = await git(mainRoot, ["rev-parse", "refs/heads/main"]);
	if ((await run(mainRoot, ["merge-base", "--is-ancestor", branchSha, mainSha])).code !== 0) {
		// A squash or cherry-pick can carry the same net changes without containing
		// the original commits. A virtual merge must add nothing to main's tree.
		const merged = await run(mainRoot, ["merge-tree", "--write-tree", mainSha, branchSha]);
		const mainTree = await git(mainRoot, ["rev-parse", `${mainSha}^{tree}`]);
		if (merged.code !== 0 || merged.stdout.split("\n", 1)[0] !== mainTree) {
			throw new Error(`main does not yet contain the changes on ${branch}. If there is a PR, ask the user before merging it; otherwise ask the user before merging the branch into main. Then retry cleanup.`);
		}
	}
	return { mainRoot, branchSha, branchExists };
}

/** Remove the verified worktree and branch, migrating all its saved sessions to main. */
export async function finishBranchCleanup(
	manifest: SessionManifest, sessionFile: string, mainRoot: string, expectedSha: string, branchExists = true,
): Promise<string> {
	const branch = manifest.createdBranch ?? manifest.targetBranch;
	const ref = branch ? `refs/heads/${branch}` : "";
	const currentRef = ref ? await run(manifest.repoRoot, ["rev-parse", "--verify", ref]) : null;
	if (!branch || await currentBranch(manifest.worktreeRoot) !== (branchExists ? branch : null) ||
		(branchExists ? currentRef?.code !== 0 || currentRef.stdout.trim() !== expectedSha : currentRef?.code === 0) ||
		await git(manifest.worktreeRoot, ["rev-parse", "HEAD"]) !== expectedSha) {
		throw new Error("The feature branch moved during cleanup; nothing was removed.");
	}
	if (await findCommonGitDir(mainRoot) !== manifest.commonGitDir ||
		!(await listWorktrees(manifest.repoRoot)).some((entry) => entry.branch === "main" &&
			path.resolve(entry.path) === path.resolve(mainRoot)) ||
		await git(mainRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]) !== "main") {
		throw new Error("The main worktree changed branches during cleanup.");
	}
	// Recheck main after the agent turn. No merge or branch deletion is allowed
	// when main no longer proves the branch is integrated.
	const mainSha = await git(mainRoot, ["rev-parse", "HEAD"]);
	if ((await run(mainRoot, ["merge-base", "--is-ancestor", expectedSha, mainSha])).code !== 0) {
		const merged = await run(mainRoot, ["merge-tree", "--write-tree", mainSha, expectedSha]);
		if (merged.code !== 0 || merged.stdout.split("\n", 1)[0] !== await git(mainRoot, ["rev-parse", `${mainSha}^{tree}`])) {
			throw new Error("main changed and no longer proves inclusion of the feature branch; cleanup was cancelled.");
		}
	}
	await assertWorktreeReleasable(manifest);
	const dir = sessionDirectoryForCwd(manifest.sessionHubCwd ?? manifest.repoRoot, inferredAgentDir(manifest));
	const files = (await fs.promises.readdir(dir).catch(() => [] as string[]))
		.filter((name) => name.endsWith(".jsonl")).map((name) => path.join(dir, name));
	const current = await canonicalSessionFilePath(sessionFile);
	if (!files.some((file) => path.resolve(file) === current)) files.push(current);
	const migrated: SessionResumeRecord[] = [];
	const releases: Array<() => Promise<void>> = [];
	const locked = new Set<string>();
	const leaseOtherSession = async (file: string): Promise<void> => {
		const canonical = await canonicalSessionFilePath(file);
		if (canonical === current || locked.has(canonical)) return;
		releases.push(await acquireSessionLease(file));
		locked.add(canonical);
	};
	try {
		for (const file of files) {
			const record = await loadResumeRecord(file);
			if (record?.targetRef !== `refs/heads/${branch}` || record.commonGitDir !== manifest.commonGitDir) continue;
			if ((await run(mainRoot, ["merge-base", "--is-ancestor", record.resumeSha, expectedSha])).code !== 0) {
				throw new Error(`Saved session ${file} is not part of the feature branch; cleanup was cancelled.`);
			}
			await leaseOtherSession(file);
			migrated.push(record);
		}
		for (const file of files) {
			const cwd = await sessionCwd(file);
			if (!cwd || (cwd !== manifest.worktreeRoot && !cwd.startsWith(`${manifest.worktreeRoot}${path.sep}`))) continue;
			await leaseOtherSession(file);
		}
		// Protected resume refs make a partial failure recoverable until all
		// transcripts have been moved; the branch remains until migration succeeds.
		await checkpointWorktreeSessions(manifest, sessionFile);
		const records = new Map(migrated.map((record) => [record.sessionFile, record]));
		for (const file of files) {
			const record = await loadResumeRecord(file);
			if (record?.targetRef === `refs/heads/${branch}` && record.commonGitDir === manifest.commonGitDir) {
				records.set(record.sessionFile, record);
			}
		}
		for (const record of records.values()) {
			const relative = record.sessionCwdRelative ?? record.launchCwdRelative;
			const candidate = path.resolve(mainRoot, relative);
			if (candidate !== mainRoot && !candidate.startsWith(`${mainRoot}${path.sep}`)) {
				throw new Error(`Saved session ${record.sessionFile} has an unsafe cwd.`);
			}
			const destination = (await fs.promises.stat(candidate).catch(() => null))?.isDirectory()
				? candidate : mainRoot;
			await rewriteSessionCwd(record.sessionFile, destination);
			await consumeResumeRecord(record);
		}
		const intendedDestination = path.join(mainRoot, manifest.launchCwdRelative);
		const destination = (await fs.promises.stat(intendedDestination).catch(() => null))?.isDirectory()
			? intendedDestination : mainRoot;
		await releaseManagedWorktree(manifest);
		if ((await listWorktrees(manifest.repoRoot)).some((entry) => entry.branch === branch)) {
			throw new Error(`The feature branch ${branch} is still checked out elsewhere; the worktree was released but the branch was preserved.`);
		}
		if (branchExists && manifest.createdBranch) await git(mainRoot, ["update-ref", "-d", ref, expectedSha]);
		return destination;
	} finally {
		for (const release of releases.reverse()) await release();
	}
}

export async function releaseManagedWorktree(manifest: SessionManifest): Promise<void> {
	await assertWorktreeReleasable(manifest);
	await cleanLinkedIgnoredPaths(manifest);
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

async function processStartedAt(pid: number): Promise<string> {
	return execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
		env: { ...process.env, LC_ALL: "C" },
	}).then((result) => result.stdout.trim(), () => "");
}

async function publicationOwnerAlive(pid: number, startedAt?: string, createdAt?: number): Promise<boolean> {
	if (!processIsAlive(pid)) return false;
	const actual = await processStartedAt(pid);
	if (!actual) return true; // Unknown process identity: never reclaim speculatively.
	if (startedAt) return actual === startedAt;
	const startTime = Date.parse(actual);
	return !createdAt || !Number.isFinite(startTime) || startTime <= createdAt + 1000;
}

async function acquireLegacyPublishLock(commonGitDir: string, startedAt: string): Promise<() => Promise<void>> {
	const lockDir = path.join(commonGitDir, "pi-worktree-publish.lock");
	const token = randomUUID();
	for (let attempt = 0; attempt < 200; attempt++) {
		const candidate = `${lockDir}.${process.pid}.${token}`;
		await fs.promises.mkdir(candidate);
		await fs.promises.writeFile(
			path.join(candidate, "owner.json"),
			`${JSON.stringify({ pid: process.pid, token, createdAt: Date.now(), startedAt })}\n`,
			"utf8",
		);
		try {
			await fs.promises.rename(candidate, lockDir);
			return async () => {
				const owner = await fs.promises.readFile(path.join(lockDir, "owner.json"), "utf8").catch(() => "");
				if (owner && (JSON.parse(owner) as { token?: string }).token === token) {
					await fs.promises.rm(lockDir, { recursive: true, force: true });
				}
			};
		} catch (error) {
			await fs.promises.rm(candidate, { recursive: true, force: true });
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
			const ownerText = await fs.promises.readFile(path.join(lockDir, "owner.json"), "utf8").catch(() => "");
			let owner: { pid?: number; token?: string; startedAt?: string; createdAt?: number } = {};
			try { owner = JSON.parse(ownerText) as typeof owner; } catch { /* Fail closed for malformed locks. */ }
			if (!owner.pid || !owner.token ||
				await publicationOwnerAlive(owner.pid, owner.startedAt, owner.createdAt)) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				continue;
			}
			// Only new processes use the ref lock, so stale directory reclamation
			// is serialized with every other new process. An older process can still
			// acquire the directory first; in that case our rename simply retries.
			const quarantine = `${lockDir}.dead.${token}`;
			try {
				await fs.promises.rename(lockDir, quarantine);
			} catch (renameError) {
				if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw renameError;
			}
			const moved = await fs.promises.readFile(path.join(quarantine, "owner.json"), "utf8").catch(() => "");
			if (moved !== ownerText) {
				await fs.promises.rename(quarantine, lockDir);
				continue;
			}
			await fs.promises.rm(quarantine, { recursive: true, force: true });
		}
	}
	throw new Error("Timed out waiting for another Pi session to publish Git changes.");
}

export async function acquirePublishLock(commonGitDir: string): Promise<() => Promise<void>> {
	const ref = "refs/pi-worktree-locks/publication";
	const zero = "0".repeat(40);
	const gitDir = (...args: string[]) => run(commonGitDir, [`--git-dir=${commonGitDir}`, ...args]);
	const token = randomUUID();
	const startedAt = await processStartedAt(process.pid);
	const candidate = path.join(commonGitDir, `pi-worktree-publish.${process.pid}.${token}.tmp`);
	let sha: string;
	try {
		await fs.promises.writeFile(candidate, `${JSON.stringify({ pid: process.pid, token, createdAt: Date.now(), startedAt })}\n`, { flag: "wx" });
		const hashed = await gitDir("hash-object", "-w", candidate);
		if (hashed.code !== 0) throw new Error(hashed.stderr);
		sha = hashed.stdout.trim();
	} finally {
		await fs.promises.rm(candidate, { force: true });
	}
	for (let attempt = 0; attempt < 200; attempt++) {
		// Legacy Pi processes use a directory lock. Honor a live owner during
		// upgrades, but don't let a dead legacy PID block every future session.
		const legacy = path.join(commonGitDir, "pi-worktree-publish.lock", "owner.json");
		const legacyText = await fs.promises.readFile(legacy, "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return "";
			throw error;
		});
		if (legacyText) {
			let owner: { pid?: number; startedAt?: string; createdAt?: number } = {};
			try { owner = JSON.parse(legacyText) as typeof owner; } catch { /* Unknown owner: wait safely. */ }
			if (!owner.pid || await publicationOwnerAlive(owner.pid, owner.startedAt, owner.createdAt)) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				continue;
			}
		}

		const current = await gitDir("rev-parse", "--verify", ref);
		if (current.code !== 0 && current.code !== 1 && current.code !== 128) throw new Error(current.stderr);
		const oldSha = current.code === 0 ? current.stdout.trim() : zero;
		if (oldSha !== zero) {
			const blob = await gitDir("cat-file", "blob", oldSha);
			if (blob.code !== 0) throw new Error(`Cannot verify Pi publication lock ${oldSha}.`);
			let owner = 0;
			let ownerStart = "";
			try {
				const record = JSON.parse(blob.stdout) as { pid?: unknown; startedAt?: unknown };
				owner = Number(record.pid);
				ownerStart = typeof record.startedAt === "string" ? record.startedAt : "";
			} catch { /* Unknown owner: wait safely. */ }
			if (!owner || await publicationOwnerAlive(owner, ownerStart)) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				continue;
			}
		}
		// Git's expected-old-value update is atomic across all Pi processes.
		// A dead owner is replaced without a remove/recreate race.
		const updated = await gitDir("update-ref", ref, sha, oldSha);
		if (updated.code === 0) {
			let releaseLegacy: () => Promise<void>;
			try {
				// Older Pi processes do not know about the ref. Hold their directory
				// lock for the entire publication as well as the new atomic ref.
				releaseLegacy = await acquireLegacyPublishLock(commonGitDir, startedAt);
			} catch (error) {
				await gitDir("update-ref", "-d", ref, sha);
				throw error;
			}
			return async () => {
				let legacyError: unknown;
				try { await releaseLegacy(); } catch (error) { legacyError = error; }
				const released = await gitDir("update-ref", "-d", ref, sha);
				if (released.code !== 0) throw new Error(`Could not release Pi publication lock: ${released.stderr}`);
				if (legacyError) throw legacyError;
			};
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
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
