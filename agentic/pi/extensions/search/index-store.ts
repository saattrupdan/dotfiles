/**
 * SQLite-backed index store for the search and read extensions.
 *
 * Manages two tables:
 * - `files`   — file manifest (path, lines, size, language, sha, mtime, doc)
 * - `symbols` — extracted symbols (name, kind, file, line_start, line_end, parent, signature, doc)
 *
 * Each repo gets its own index.db under `~/.pi/index/<repo-id>/`.
 */

const SCHEMA_VERSION = 6;

import { execSync, spawn, ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";

type DatabaseInstance = ReturnType<typeof Database>;
import type { OutlineEntry, OutlineResult } from "../_outliner/outliner.js";

export type OutlinerFn = (filePath: string, source: string) => OutlineResult;

// ---------------------------------------------------------------------------
// Repo ID resolution
// ---------------------------------------------------------------------------

function sha1(input: string): string {
	return crypto.createHash("sha1").update(input).digest("hex").slice(0, 16);
}

/**
 * Resolve a repo ID for the given cwd.
 * - git worktrees: use git rev-parse --git-common-dir → parent → sha1[:16]
 * - git repos: use git rev-parse --show-toplevel → sha1[:16]
 * - non-git: sha1(realpath(cwd))[:16]
 */
export function resolveRepoId(cwd: string): string {
	try {
		const output = execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
		const root = output.trim();
		return sha1(root);
	} catch {
		// Try git-common-dir for worktrees
		try {
			const out = execSync("git rev-parse --git-common-dir", { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
			const gitDir = out.trim();
			const parent = path.dirname(gitDir);
			return sha1(parent);
		} catch {
			// Fall back to sha1 of realpath
			const realPath = fs.realpathSync(cwd);
			return sha1(realPath);
		}
	}
}

/**
 * Get the index directory for a repo ID.
 */
function getIndexDir(repoId: string): string {
	const home = os.homedir();
	return path.join(home, ".pi", "index", repoId);
}

/**
 * Get the index DB path for a repo ID.
 */
export function getIndexDbPath(repoId: string): string {
	return path.join(getIndexDir(repoId), "index.db");
}

/**
 * Get the meta.json path for a repo ID.
 */
export function getMetaPath(repoId: string): string {
	return path.join(getIndexDir(repoId), "meta.json");
}

// ---------------------------------------------------------------------------
// Meta management
// ---------------------------------------------------------------------------

/**
 * Write meta.json for a repo.
 */
export function writeMeta(repoId: string, root: string): void {
	const metaPath = getMetaPath(repoId);
	const meta = {
		root,
		created: new Date().toISOString(),
		last_used: Date.now(),
	};
	fs.mkdirSync(path.dirname(metaPath), { recursive: true });
	fs.writeFileSync(metaPath, JSON.stringify(meta));
}

/**
 * Update last_used in meta.json.
 */
export function touchMeta(repoId: string): void {
	const metaPath = getMetaPath(repoId);
	try {
		const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
		meta.last_used = Date.now();
		fs.writeFileSync(metaPath, JSON.stringify(meta));
	} catch {
		// meta doesn't exist yet — that's fine, it'll be created on full build
	}
}

/**
 * Read meta.json for a repo.
 */
export function readMeta(repoId: string): { root: string; created: string; last_used: number } | null {
	const metaPath = getMetaPath(repoId);
	try {
		const raw = fs.readFileSync(metaPath, "utf-8");
		const meta = JSON.parse(raw);
		return {
			root: meta.root,
			created: meta.created,
			last_used: meta.last_used,
		};
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

/**
 * Open (or create) the index database and ensure schema exists.
 */
export function openDb(repoId: string): DatabaseInstance {
	const dbPath = getIndexDbPath(repoId);
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });

	// Open the database — if better-sqlite3 is incompatible, this throws.
	// The error message tells the user to run `npm rebuild better-sqlite3`.
	const db = Database(dbPath);

	const currentVersion = (db.pragma("user_version", { simple: true }) as number) ?? 0;
	if (currentVersion !== SCHEMA_VERSION) {
		db.exec(`
			DROP TABLE IF EXISTS symbols;
			DROP TABLE IF EXISTS files;
		`);
		db.pragma(`user_version = ${SCHEMA_VERSION}`);
	}

	db.exec(`
		CREATE TABLE IF NOT EXISTS files (
			path    TEXT PRIMARY KEY,
			lines   INTEGER,
			size    INTEGER,
			language TEXT,
			sha     TEXT,
			mtime   INTEGER,
			doc     TEXT
		);

		CREATE TABLE IF NOT EXISTS symbols (
			name       TEXT,
			kind       TEXT,
			file       TEXT,
			line_start INTEGER,
			line_end   INTEGER,
			parent     TEXT,
			signature  TEXT,
			doc        TEXT,
			PRIMARY KEY (name, file, line_start)
		);

		CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
		CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
	`);

	return db;
}

/**
 * Full rebuild: delete all data and re-populate from scratch.
 */
export function rebuildIndex(db: DatabaseInstance, _repoId: string, _repoRoot: string): void {
	const stmt = db.prepare("DELETE FROM symbols");
	stmt.run();
	const stmt2 = db.prepare("DELETE FROM files");
	stmt2.run();
	// Rebuild is done by the caller by inserting rows
}

/**
 * Insert a file row into the index.
 */
export function insertFile(
	db: DatabaseInstance,
	relativePath: string,
	lines: number,
	size: number,
	language: string,
	sha: string,
	mtime: number,
	doc: string | null = null,
): void {
	const stmt = db.prepare(
		`INSERT OR REPLACE INTO files (path, lines, size, language, sha, mtime, doc)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	stmt.run(relativePath, lines, size, language, sha, mtime, doc);
}

/**
 * Insert a symbol row into the index.
 */
export function insertSymbol(
	db: DatabaseInstance,
	entry: OutlineEntry,
	file: string,
): void {
	const stmt = db.prepare(
		`INSERT OR REPLACE INTO symbols (name, kind, file, line_start, line_end, parent, signature, doc)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	stmt.run(
		entry.name,
		entry.kind,
		file,
		entry.line,
		entry.lineEnd,
		entry.parent ?? null,
		entry.signature ?? null,
		entry.docFirstLine ?? null,
	);
}

/**
 * Read the full outline (module doc + symbols ordered by line) for a file.
 */
export function getFileOutline(
	db: DatabaseInstance,
	file: string,
): { doc: string | null; entries: OutlineEntry[] } | null {
	const fileStmt = db.prepare("SELECT doc FROM files WHERE path = ?");
	const fileRow = fileStmt.get(file) as { doc: string | null } | undefined;
	if (!fileRow) return null;

	const symStmt = db.prepare(
		`SELECT name, kind, line_start, line_end, parent, signature, doc
		 FROM symbols WHERE file = ? ORDER BY line_start ASC`,
	);
	const rows = symStmt.all(file) as {
		name: string;
		kind: string;
		line_start: number;
		line_end: number;
		parent: string | null;
		signature: string | null;
		doc: string | null;
	}[];

	const entries: OutlineEntry[] = rows.map((r) => ({
		line: r.line_start,
		lineEnd: r.line_end,
		kind: r.kind as OutlineEntry["kind"],
		name: r.name,
		parent: r.parent ?? undefined,
		signature: r.signature ?? undefined,
		docFirstLine: r.doc ?? undefined,
	}));

	return { doc: fileRow.doc, entries };
}

/**
 * Look up a single symbol (line range) by file and (optionally dotted) name.
 * Supports "Class.method" — splits on the last dot for parent disambiguation.
 */
export function getSymbol(
	db: DatabaseInstance,
	file: string,
	dottedName: string,
): { line_start: number; line_end: number; kind: string; name: string; parent: string | null } | null {
	// Exact-name match wins — handles entries whose own name contains a dot
	// (e.g. TOML `[tool.poetry]`, CSS selectors like `.btn:hover`).
	const exactStmt = db.prepare(
		`SELECT name, kind, line_start, line_end, parent
		 FROM symbols WHERE file = ? AND name = ?
		 ORDER BY (parent IS NULL) DESC, line_start ASC LIMIT 1`,
	);
	const exact = exactStmt.get(file, dottedName) as
		| { name: string; kind: string; line_start: number; line_end: number; parent: string | null }
		| undefined;
	if (exact) return exact;

	// Fall back to dotted Parent.Child disambiguation.
	const dot = dottedName.lastIndexOf(".");
	if (dot >= 0) {
		const parent = dottedName.slice(0, dot);
		const name = dottedName.slice(dot + 1);
		const stmt = db.prepare(
			`SELECT name, kind, line_start, line_end, parent
			 FROM symbols WHERE file = ? AND name = ? AND parent = ?
			 ORDER BY line_start ASC LIMIT 1`,
		);
		const row = stmt.get(file, name, parent) as
			| { name: string; kind: string; line_start: number; line_end: number; parent: string | null }
			| undefined;
		return row ?? null;
	}
	return null;
}

/**
 * Query symbols by name (substring match), prioritising class and function defs.
 */
export interface SymbolResult {
	name: string;
	kind: string;
	file: string;
	line_start: number;
	line_end: number;
	parent: string | null;
}

export function querySymbols(db: DatabaseInstance, query: string): SymbolResult[] {
	const stmt = db.prepare(
		`SELECT name, kind, file, line_start, line_end, parent
		 FROM symbols
		 WHERE LOWER(name) LIKE LOWER(?)
		 ORDER BY kind = 'class' OR kind = 'function' DESC
		 LIMIT 50`,
	);
	const results = stmt.all(`%${query}%`);
	return results as unknown as SymbolResult[];
}

/**
 * Query files for exact name match (for promotion).
 */
/**
 * Query files by path substring (case-insensitive). Used to surface filename
 * matches alongside symbol/content hits.
 */
export function queryFilesByName(db: DatabaseInstance, query: string): { path: string; lines: number }[] {
	const stmt = db.prepare(
		`SELECT path, lines FROM files
		 WHERE LOWER(path) LIKE LOWER(?)
		 ORDER BY length(path) ASC
		 LIMIT 50`,
	);
	return stmt.all(`%${query}%`) as { path: string; lines: number }[];
}

export function queryExactSymbol(db: DatabaseInstance, query: string): SymbolResult[] {
	const stmt = db.prepare(
		`SELECT name, kind, file, line_start, line_end, parent
		 FROM symbols
		 WHERE LOWER(name) = LOWER(?)`,
	);
	const results = stmt.all(query);
	return results as unknown as SymbolResult[];
}

/**
 * Remove files that no longer exist on disk.
 */
/**
 * Remove files that no longer exist on disk.
 * For large indexes, processes deletions in chunks to avoid blocking.
 */
export function removeMissingFiles(
	db: DatabaseInstance,
	existingPaths: Set<string>,
	asyncCallback?: (_deleted: number, _total: number) => void,
): void {
	const stmt = db.prepare("SELECT path FROM files");
	const rows = stmt.all() as { path: string }[];
	const toDelete = rows
		.filter((r) => !existingPaths.has(r.path))
		.map((r) => r.path);

	if (toDelete.length === 0) {
		asyncCallback?.(0, 0);
		return;
	}

	// For small deletion sets, do it synchronously.
	const SYNC_THRESHOLD = 1_000;
	if (toDelete.length <= SYNC_THRESHOLD || !asyncCallback) {
		const stmt2 = db.prepare("DELETE FROM files WHERE path = ?");
		const stmt3 = db.prepare("DELETE FROM symbols WHERE file = ?");
		for (const p of toDelete) {
			stmt2.run(p);
			stmt3.run(p);
		}
		asyncCallback?.(toDelete.length, toDelete.length);
		return;
	}

	// For large deletion sets, process in chunks asynchronously.
	let index = 0;
	const BATCH_SIZE = 200;
	const stmt2 = db.prepare("DELETE FROM files WHERE path = ?");
	const stmt3 = db.prepare("DELETE FROM symbols WHERE file = ?");

	const deleteNextBatch = (): void => {
		const end = Math.min(index + BATCH_SIZE, toDelete.length);

		for (; index < end; index++) {
			const p = toDelete[index];
			stmt2.run(p);
			stmt3.run(p);
		}

		asyncCallback(index, toDelete.length);

		if (index < toDelete.length) {
			setImmediate(deleteNextBatch);
		}
	};

	setImmediate(deleteNextBatch);
}

/**
 * Incrementally update: stat every file in the DB, re-parse only changed ones.
 * Returns the set of existing file paths.
 */
export function incrementalRefresh(
	db: DatabaseInstance,
	repoRoot: string,
	existingPaths: Set<string>,
	updateFile: (relativePath: string, content: string) => void,
): Set<string> {
	const stmt = db.prepare("SELECT path, mtime, size FROM files");
	const rows = stmt.all() as { path: string; mtime: number; size: number }[];

	const toReparse: string[] = [];

	for (const row of rows) {
		const fullPath = path.join(repoRoot, row.path);
		try {
			const stat = fs.statSync(fullPath);
			const mtimeSec = Math.floor(stat.mtime.getTime() / 1000);
			if (stat.mtimeMs !== stat.mtime.getTime() || row.mtime !== mtimeSec || row.size !== stat.size) {
				toReparse.push(row.path);
				// Update mtime/size
				const updateStmt = db.prepare(
					`UPDATE files SET mtime = ?, size = ? WHERE path = ?`,
				);
				updateStmt.run(mtimeSec, stat.size, row.path);
			}
		} catch {
			// File no longer exists — it will be removed later
		}
	}

	// Reparse changed files
	for (const relPath of toReparse) {
		const fullPath = path.join(repoRoot, relPath);
		try {
			const content = fs.readFileSync(fullPath, "utf-8");
			updateFile(relPath, content);
		} catch {
			// Silently skip
		}
	}

	// Remove missing files
	removeMissingFiles(db, existingPaths);

	return existingPaths;
}

// ---------------------------------------------------------------------------
// Shared bootstrap (used by both `search` and `read` extensions)
// ---------------------------------------------------------------------------

let cachedDb: DatabaseInstance | null = null;
let cachedRepoId: string | null = null;
let cachedRepoRoot: string | null = null;

const LANG_MAP: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".py": "python",
	".vue": "vue",
	".md": "markdown",
	".json": "json",
};

function detectLanguage(filePath: string): string {
	return LANG_MAP[path.extname(filePath).toLowerCase()] ?? "text";
}

/**
 * Open (and cache) the per-repo index. Does NOT build — callers that need a
 * fully populated index (e.g. `search`) should call `ensureFullIndex` instead.
 * Cheap enough to call on every tool invocation.
 */
export function openIndex(cwd: string): {
	db: DatabaseInstance;
	repoId: string;
	repoRoot: string;
} {
	const repoRoot = path.resolve(cwd);
	// Cache is keyed by the resolved cwd: the session cwd can change between
	// calls (and `search` vs `read` may pass different cwds), so a cache that
	// ignored cwd would pin every lookup to whichever directory was seen first.
	if (cachedDb && cachedRepoRoot === repoRoot && cachedRepoId) {
		return { db: cachedDb, repoId: cachedRepoId, repoRoot: cachedRepoRoot };
	}

	const repoId = resolveRepoId(cwd);
	writeMeta(repoId, repoRoot);

	const db = openDb(repoId);
	cachedDb = db;
	cachedRepoId = repoId;
	cachedRepoRoot = repoRoot;

	return { db, repoId, repoRoot };
}

/**
 * Open the index and build it from scratch if it's empty. Used by `search`,
 * which needs every file indexed up-front. NOT used by `read` — read indexes
 * lazily per file.
 */
export function ensureFullIndex(cwd: string, outline: OutlinerFn): {
	db: DatabaseInstance;
	repoId: string;
	repoRoot: string;
} {
	const handle = openIndex(cwd);
	const count = handle.db
		.prepare("SELECT COUNT(*) AS cnt FROM files")
		.all()[0] as { cnt: number };
	if (count.cnt === 0) {
		buildIndex(handle.db, handle.repoRoot, outline);
	}
	return handle;
}

/**
 * Full build from scratch.
 */
function buildIndex(db: DatabaseInstance, repoRoot: string, outline: OutlinerFn): void {
	const files = listFiles(repoRoot);
	for (const relPath of files) {
		const fullPath = path.join(repoRoot, relPath);
		try {
			const content = fs.readFileSync(fullPath, "utf-8");
			indexFile(db, repoRoot, relPath, content, outline);
		} catch {
			// Skip unreadable files
		}
	}
}

/**
 * Index a single file: write its file row + delete-and-reinsert its symbols.
 * Used both by full build and incremental refresh.
 */
export function indexFile(
	db: DatabaseInstance,
	repoRoot: string,
	relPath: string,
	content: string,
	outline: OutlinerFn,
): void {
	const fullPath = path.join(repoRoot, relPath);
	const lines = content.split("\n").length;
	const size = Buffer.byteLength(content);
	const stat = fs.statSync(fullPath);
	const mtimeSec = Math.floor(stat.mtime.getTime() / 1000);
	const sha = crypto.createHash("sha256").update(content).digest("hex");
	const lang = detectLanguage(relPath);

	const result = outline(fullPath, content);
	insertFile(db, relPath, lines, size, lang, sha, mtimeSec, result.moduleDoc ?? null);

	const deleteStmt = db.prepare("DELETE FROM symbols WHERE file = ?");
	deleteStmt.run(relPath);
	for (const entry of result.entries) {
		insertSymbol(db, entry, relPath);
	}
}

/**
 * Refresh a single file in-place. Returns true if anything changed.
 */
export function refreshFile(
	db: DatabaseInstance,
	repoRoot: string,
	relPath: string,
	outline: OutlinerFn,
): boolean {
	const fullPath = path.join(repoRoot, relPath);
	try {
		const stat = fs.statSync(fullPath);
		const mtimeSec = Math.floor(stat.mtime.getTime() / 1000);
		const size = stat.size;
		const row = db
			.prepare("SELECT mtime, size FROM files WHERE path = ?")
			.get(relPath) as { mtime: number; size: number } | undefined;
		if (row && row.mtime === mtimeSec && row.size === size) return false;
		const content = fs.readFileSync(fullPath, "utf-8");
		indexFile(db, repoRoot, relPath, content, outline);
		return true;
	} catch {
		return false;
	}
}

/**
 * Reconcile the index against the live working tree: index files created since
 * the last build, re-parse changed ones, and drop files that no longer exist.
 *
 * `refreshFile` already handles all three cases — it inserts new files (no DB
 * row), skips unchanged ones (matching mtime/size), and re-parses changed ones.
 * The earlier "iterate existing DB rows" approach never discovered new files,
 * leaving the index frozen at its first build.
 */


/**
 * Reconcile the index against the live working tree in the background.
 * Always runs asynchronously to avoid blocking the event loop — even small
 * repos can stall the UI if tree-sitter parsing blocks the main thread.
 */
export async function reconcileIndexAsync(
	db: DatabaseInstance,
	repoRoot: string,
	outline: OutlinerFn,
	onProgress?: (_processed: number, _total: number) => void,
): Promise<void> {
	const diskFiles = await listFilesAsync(repoRoot);
	const totalFiles = diskFiles.length;

	if (totalFiles === 0) {
		if (onProgress) onProgress(0, 0);
		return;
	}

	// Process files in batches to avoid blocking the event loop.
	const BATCH_SIZE = 200;
	let processed = 0;

	const processBatch = async (): Promise<void> => {
		const end = Math.min(processed + BATCH_SIZE, totalFiles);

		for (let i = processed; i < end; i++) {
			try {
				refreshFile(db, repoRoot, diskFiles[i], outline);
			} catch {
				// Skip files that fail to parse
			}
		}

		processed = end;
		if (onProgress) onProgress(processed, totalFiles);

		if (processed < totalFiles) {
			// Yield to event loop before next batch
			await new Promise((resolve) => setImmediate(resolve));
			await processBatch();
		} else {
			// Done - remove deleted files
			removeMissingFiles(db, new Set(diskFiles));
		}
	};

	await processBatch();
}

/**
 * Recursively list all files in a directory tree, skipping VCS, dependency, and
 * build/cache directories that would otherwise flood the index with noise.
 */
/**
 * Recursively list all files in a repo, respecting .gitignore.
 * Uses `git ls-files` when available (fast, respects .gitignore),
 * falls back to manual walk for non-git directories.
 */
/**
 * Asynchronously list all files in a repo, respecting .gitignore.
 * Returns a promise to avoid blocking the event loop.
 */
export async function listFilesAsync(repoRoot: string): Promise<string[]> {
	return new Promise((resolve) => {
		// Try git ls-files first - it respects .gitignore automatically
		// Use async spawn to avoid blocking the event loop
		const child: ChildProcess = spawn("git", ["ls-files"], {
			cwd: repoRoot,
		});

		let stdout = "";
		let stderr = "";
		let completed = false;

		// Timeout after 5 seconds - git shouldn't take this long
		const timeout = setTimeout(() => {
			if (!completed) {
				child.kill("SIGKILL");
				resolve(listFilesManual(repoRoot));
			}
		}, 5000);

		if (child.stdout) {
			child.stdout.on("data", (data: Buffer) => {
				stdout += data.toString();
			});
		}

		if (child.stderr) {
			child.stderr.on("data", (data: Buffer) => {
				stderr += data.toString();
			});
		}

		child.on("close", (code: number | null) => {
			completed = true;
			clearTimeout(timeout);
			if (code === 0 && stdout.trim()) {
				resolve(
					stdout
						.split("\n")
						.filter((line) => line.trim() !== "")
				);
			} else {
				// Git failed - log stderr for diagnostics, then fall back to manual walk
				if (stderr.trim()) {
					console.warn(`git ls-files failed: ${stderr.trim()}`);
				}
				resolve(listFilesManual(repoRoot));
			}
		});

		child.on("error", (err: Error) => {
			completed = true;
			clearTimeout(timeout);
			console.warn(`git ls-files error: ${err.message}`);
			resolve(listFilesManual(repoRoot));
		});
	});
}

/**
 * Manual file walk when git is unavailable or fails.
 */
export function listFilesManual(repoRoot: string): string[] {
	const results: string[] = [];
	const skipDirs = new Set([
		".git",
		"node_modules",
		".pi",
		".venv",
		"venv",
		"__pycache__",
		".ruff_cache",
		".mypy_cache",
		".pytest_cache",
		".Trash",
	]);

	function walk(dir: string): void {
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (skipDirs.has(entry.name)) continue;
					walk(fullPath);
				} else {
					const relPath = path.relative(repoRoot, fullPath);
					results.push(relPath);
				}
			}
		} catch {
			// Skip unreadable directories
		}
	}

	walk(repoRoot);
	return results;
}

/**
 * Synchronous wrapper for backwards compatibility - DO NOT USE in hot paths.
 * @deprecated Use listFilesAsync instead
 */
export function listFiles(repoRoot: string): string[] {
	return listFilesManual(repoRoot);
}
