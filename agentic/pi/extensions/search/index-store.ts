/**
 * SQLite-backed index store for the search and read extensions.
 *
 * Manages two tables:
 * - `files`   — file manifest (path, lines, size, language, sha, mtime, doc)
 * - `symbols` — extracted symbols (name, kind, file, line_start, line_end, parent, signature, doc)
 *
 * Each repo gets its own index.db under `~/.pi/index/<repo-id>/`.
 */

const SCHEMA_VERSION = 8; // Adds an explicit completion marker for resumable async builds.
const COMPATIBLE_SCHEMA_VERSION = 7;
const FILE_COLUMNS = ["path", "lines", "size", "language", "sha", "mtime", "doc"];
const SYMBOL_COLUMNS = ["name", "kind", "file", "line_start", "line_end", "parent", "signature", "doc"];

import { execSync, spawn, ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";

type DatabaseInstance = ReturnType<typeof Database>;
import type { OutlineEntry, OutlineResult } from "../_outliner/outliner.js";

export type OutlinerFn = (filePath: string, source: string) => OutlineResult;

type IndexBuildState = "incomplete" | "complete";

type FileFingerprint = {
	size: number;
	mtimeMs: number;
	ino: number | undefined;
	sha: string;
};

class FileDeletedDuringIndexError extends Error {
	readonly code = "ESTALE";

	constructor(relativePath: string) {
		super(`File was deleted while indexing: ${relativePath}`);
		this.name = "FileDeletedDuringIndexError";
	}
}

class FileChangedDuringIndexError extends Error {
	readonly code = "ESTALE";

	constructor(relativePath: string) {
		super(`File changed while indexing: ${relativePath}`);
		this.name = "FileChangedDuringIndexError";
	}
}

type ProgressCallback = (_processed: number, _total: number) => void;

type ActiveReconcile = {
	promise: Promise<void>;
	subscribers: Set<ProgressCallback>;
};

const activeReconciles = new Map<string, ActiveReconcile>();

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
	const knownTables = new Set(["files", "symbols", "index_meta"]);
	const existingTables = new Set(
		(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as { name: string }[]).map((row) => row.name),
	);
	const hasIndexTables = [...knownTables].some((name) => existingTables.has(name));
	const columns = (table: string): string[] => {
		if (!existingTables.has(table)) return [];
		return (db.pragma(`table_info(${table})`) as unknown as { name: string }[]).map((column) => column.name);
	};
	const hasRequiredColumns = (table: string, required: string[]): boolean => {
		const actual = new Set(columns(table));
		return required.every((column) => actual.has(column));
	};
	const compatibleDataTables =
		hasRequiredColumns("files", FILE_COLUMNS) && hasRequiredColumns("symbols", SYMBOL_COLUMNS);
	const compatibleMetaTable =
		!existingTables.has("index_meta") || hasRequiredColumns("index_meta", ["key", "value"]);
	const preserve =
		!hasIndexTables ||
		((currentVersion === COMPATIBLE_SCHEMA_VERSION || currentVersion === SCHEMA_VERSION || currentVersion === 0) &&
			compatibleDataTables &&
			compatibleMetaTable);

	if (!preserve) {
		// Never promote an unknown or incompatible shape while leaving its rows
		// behind. A fresh schema is safer than querying columns with old meanings.
		db.exec(`
			DROP TABLE IF EXISTS symbols;
			DROP TABLE IF EXISTS files;
			DROP TABLE IF EXISTS index_meta;
		`);
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

		CREATE TABLE IF NOT EXISTS index_meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);
	db.pragma(`user_version = ${SCHEMA_VERSION}`);

	const state = db.prepare("SELECT value FROM index_meta WHERE key = 'build_state'").get() as { value: string } | undefined;
	if (state?.value !== "complete" && state?.value !== "incomplete") {
		db.prepare("INSERT OR REPLACE INTO index_meta (key, value) VALUES ('build_state', 'incomplete')").run();
	}

	return db;
}

/**
 * Full rebuild: delete all data and re-populate from scratch.
 */
export function rebuildIndex(db: DatabaseInstance, _repoId: string, _repoRoot: string): void {
	setIndexBuildState(db, "incomplete");
	const clear = db.transaction(() => {
		db.prepare("DELETE FROM symbols").run();
		db.prepare("DELETE FROM files").run();
	});
	clear();
	// Rebuild is done by the caller by inserting rows.
}

function getIndexBuildState(db: DatabaseInstance): IndexBuildState {
	const row = db.prepare("SELECT value FROM index_meta WHERE key = 'build_state'").get() as { value: string } | undefined;
	return row?.value === "complete" ? "complete" : "incomplete";
}

function setIndexBuildState(db: DatabaseInstance, state: IndexBuildState): void {
	db.prepare("INSERT OR REPLACE INTO index_meta (key, value) VALUES ('build_state', ?)").run(state);
}

function deleteFileRows(db: DatabaseInstance, relativePath: string): void {
	const deleteRows = db.transaction((file: string) => {
		db.prepare("DELETE FROM files WHERE path = ?").run(file);
		db.prepare("DELETE FROM symbols WHERE file = ?").run(file);
	});
	deleteRows(relativePath);
}

function hashContent(content: string): string {
	return crypto.createHash("sha256").update(content).digest("hex");
}

function fingerprintFromStat(stat: fs.Stats, sha: string): FileFingerprint {
	return {
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		ino: typeof stat.ino === "number" && stat.ino > 0 ? stat.ino : undefined,
		sha,
	};
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
	return (
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		(left.ino === undefined || right.ino === undefined || left.ino === right.ino) &&
		left.sha === right.sha
	);
}

function captureFingerprint(fullPath: string): FileFingerprint {
	const content = fs.readFileSync(fullPath, "utf-8");
	return fingerprintFromStat(fs.statSync(fullPath), hashContent(content));
}

function isFile(fullPath: string): boolean {
	try {
		return fs.statSync(fullPath).isFile();
	} catch {
		return false;
	}
}

function assertFingerprint(
	db: DatabaseInstance,
	relPath: string,
	fullPath: string,
	before: FileFingerprint,
): void {
	let after: FileFingerprint;
	try {
		after = captureFingerprint(fullPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			deleteFileRows(db, relPath);
			throw new FileDeletedDuringIndexError(relPath);
		}
		throw error;
	}
	if (!sameFingerprint(before, after)) throw new FileChangedDuringIndexError(relPath);
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
	const deleteFile = db.transaction((relativePath: string) => {
		db.prepare("DELETE FROM files WHERE path = ?").run(relativePath);
		db.prepare("DELETE FROM symbols WHERE file = ?").run(relativePath);
	});

	if (toDelete.length <= SYNC_THRESHOLD || !asyncCallback) {
		for (const p of toDelete) deleteFile(p);
		asyncCallback?.(toDelete.length, toDelete.length);
		return;
	}

	// For large deletion sets, process in chunks asynchronously.
	let index = 0;
	const BATCH_SIZE = 200;

	const deleteNextBatch = (): void => {
		const end = Math.min(index + BATCH_SIZE, toDelete.length);

		for (; index < end; index++) deleteFile(toDelete[index]);

		asyncCallback(index, toDelete.length);

		if (index < toDelete.length) {
			setImmediate(deleteNextBatch);
		}
	};

	setImmediate(deleteNextBatch);
}

const ASYNC_RECONCILE_BATCH_SIZE = 200;

/**
 * Files larger than 8 MiB are kept in the manifest but not parsed for symbols.
 * This bounds synchronous source reads and parser work during reconciliation;
 * ripgrep still searches their contents independently of this index.
 */
export const MAX_SOURCE_BYTES_FOR_SYMBOLS = 8 * 1024 * 1024;

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Remove stale rows without allowing a large index to monopolise the event
 * loop. Each path is deleted in its own transaction so a failed deletion can
 * never leave only one of its two row sets behind.
 */
export async function removeMissingFilesAsync(
	db: DatabaseInstance,
	existingPaths: Set<string>,
): Promise<number> {
	const selectBatch = db.prepare(
		"SELECT path FROM files WHERE path > ? ORDER BY path LIMIT ?",
	);
	const deleteFile = db.transaction((relativePath: string) => {
		db.prepare("DELETE FROM files WHERE path = ?").run(relativePath);
		db.prepare("DELETE FROM symbols WHERE file = ?").run(relativePath);
	});
	let lastPath = "";
	let deleted = 0;

	while (true) {
		const rows = selectBatch.all(lastPath, ASYNC_RECONCILE_BATCH_SIZE) as { path: string }[];
		if (rows.length === 0) break;

		for (const row of rows) {
			if (!existingPaths.has(row.path)) {
				deleteFile(row.path);
				deleted += 1;
			}
		}
		lastPath = rows[rows.length - 1].path;
		await yieldToEventLoop();
	}

	return deleted;
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
 * Open the index and arrange for an initial build if it has not completed.
 *
 * This deliberately does no filesystem walk or parsing. The caller gets a
 * usable (possibly empty/partial) database immediately while the shared
 * reconcile job fills it in the background.
 */
export function ensureFullIndex(cwd: string, outline: OutlinerFn): {
	db: DatabaseInstance;
	repoId: string;
	repoRoot: string;
} {
	const handle = openIndex(cwd);
	if (getIndexBuildState(handle.db) !== "complete") {
		void reconcileIndexAsync(handle.db, handle.repoRoot, outline).catch(() => {
			// A later search will retry an incomplete build.
		});
	}
	return handle;
}

function metadataFingerprint(stat: fs.Stats): FileFingerprint {
	// Oversized files deliberately do not get read just to calculate a content
	// hash. Their stat tuple is still a stable fingerprint for the metadata row;
	// a size/mtime/inode change causes the next reconciliation to revisit it.
	return fingerprintFromStat(stat, hashContent(`metadata:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`));
}

function indexMetadata(db: DatabaseInstance, relPath: string, stat: fs.Stats): void {
	const replaceFile = db.transaction(() => {
		insertFile(
			db,
			relPath,
			0,
			stat.size,
			detectLanguage(relPath),
			metadataFingerprint(stat).sha,
			Math.floor(stat.mtime.getTime() / 1000),
			null,
		);
		db.prepare("DELETE FROM symbols WHERE file = ?").run(relPath);
	});
	replaceFile();
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
	const size = Buffer.byteLength(content);
	const stat = fs.statSync(fullPath);
	if (size > MAX_SOURCE_BYTES_FOR_SYMBOLS) {
		indexMetadata(db, relPath, stat);
		return;
	}
	const lines = content.split("\n").length;
	const sha = hashContent(content);
	const before = fingerprintFromStat(stat, sha);
	const mtimeSec = Math.floor(stat.mtime.getTime() / 1000);
	const lang = detectLanguage(relPath);

	// Parse before opening the write transaction. A parser failure therefore
	// leaves the previous file row and symbols untouched. If the parser itself
	// deletes the file before throwing, remove both stale row sets atomically.
	let result: OutlineResult;
	try {
		result = outline(fullPath, content);
	} catch (error) {
		if (!isFile(fullPath)) {
			deleteFileRows(db, relPath);
			throw new FileDeletedDuringIndexError(relPath);
		}
		throw error;
	}

	// A same-size rewrite can retain the same second-rounded mtime. Compare the
	// complete fingerprint, including content, before allowing the transaction.
	assertFingerprint(db, relPath, fullPath, before);
	const replaceFile = db.transaction(() => {
		insertFile(db, relPath, lines, size, lang, sha, mtimeSec, result.moduleDoc ?? null);

		const deleteStmt = db.prepare("DELETE FROM symbols WHERE file = ?");
		deleteStmt.run(relPath);
		for (const entry of result.entries) {
			insertSymbol(db, entry, relPath);
		}
	});
	replaceFile();
	try {
		// Check again after the commit to catch a rewrite racing the transaction.
		assertFingerprint(db, relPath, fullPath, before);
	} catch (error) {
		if (error instanceof FileChangedDuringIndexError) deleteFileRows(db, relPath);
		throw error;
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
		const beforeRead = fs.statSync(fullPath);
		if (beforeRead.size > MAX_SOURCE_BYTES_FOR_SYMBOLS) {
			const row = db
				.prepare("SELECT mtime, size, sha FROM files WHERE path = ?")
				.get(relPath) as { mtime: number; size: number; sha: string } | undefined;
			const fingerprint = metadataFingerprint(beforeRead);
			const mtimeSec = Math.floor(beforeRead.mtimeMs / 1000);
			if (row && row.mtime === mtimeSec && row.size === fingerprint.size && row.sha === fingerprint.sha) return false;
			indexMetadata(db, relPath, beforeRead);
			try {
				if (!sameFingerprint(fingerprint, metadataFingerprint(fs.statSync(fullPath)))) {
					deleteFileRows(db, relPath);
					return false;
				}
			} catch {
				deleteFileRows(db, relPath);
				return false;
			}
			return true;
		}
		const content = fs.readFileSync(fullPath, "utf-8");
		const afterRead = captureFingerprint(fullPath);
		const readFingerprint = fingerprintFromStat(beforeRead, hashContent(content));
		if (!sameFingerprint(readFingerprint, afterRead)) return false;

		const row = db
			.prepare("SELECT mtime, size, sha FROM files WHERE path = ?")
			.get(relPath) as { mtime: number; size: number; sha: string } | undefined;
		const mtimeSec = Math.floor(afterRead.mtimeMs / 1000);
		if (row && row.mtime === mtimeSec && row.size === afterRead.size && row.sha === afterRead.sha) return false;
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
export function reconcileIndexAsync(
	db: DatabaseInstance,
	repoRoot: string,
	outline: OutlinerFn,
	onProgress?: ProgressCallback,
): Promise<void> {
	const existing = activeReconciles.get(repoRoot);
	if (existing) {
		if (onProgress) existing.subscribers.add(onProgress);
		return existing.promise;
	}

	const subscribers = new Set<ProgressCallback>();
	if (onProgress) subscribers.add(onProgress);
	const notifyProgress = (processed: number, total: number): void => {
		for (const subscriber of subscribers) {
			try {
				subscriber(processed, total);
			} catch {
				// A UI subscriber must never abort reconciliation.
			}
		}
	};

	const job = (async (): Promise<void> => {
		// Capture this before marking the build incomplete. An incomplete build must
		// reparse every listed path, not only files whose mtime changed: a process
		// can have committed the file row before symbols.
		const rebuilding = getIndexBuildState(db) !== "complete";
		// Mark the build incomplete before enumeration. Git failure/timeout must
		// leave a completed index retryable rather than silently preserving it.
		setIndexBuildState(db, "incomplete");
		const diskFiles = await listFilesAsync(repoRoot);
		const totalFiles = diskFiles.length;
		let processed = 0;
		let everyFileSucceeded = true;

		if (totalFiles === 0) {
			await removeMissingFilesAsync(db, new Set());
			setIndexBuildState(db, "complete");
			notifyProgress(0, 0);
			return;
		}

		const MAX_FILES_PER_BATCH = 64;
		const MAX_SOURCE_BYTES_PER_BATCH = 1024 * 1024;

		while (processed < totalFiles) {
			let batchFiles = 0;
			let batchBytes = 0;

			while (processed + batchFiles < totalFiles) {
				const relPath = diskFiles[processed + batchFiles];
				let sourceBytes = 0;
				try {
					sourceBytes = fs.statSync(path.join(repoRoot, relPath)).size;
				} catch {
					// A path deleted after enumeration is handled as a successful
					// deletion by reconcileFile below.
				}

				if (
					batchFiles > 0 &&
					(batchFiles >= MAX_FILES_PER_BATCH || batchBytes + sourceBytes > MAX_SOURCE_BYTES_PER_BATCH)
				) {
					break;
				}

				if (!reconcileFile(db, repoRoot, relPath, outline, rebuilding)) everyFileSucceeded = false;
				batchFiles += 1;
				batchBytes += sourceBytes;
			}

			processed += batchFiles;
			notifyProgress(processed, totalFiles);
			if (processed < totalFiles) await new Promise<void>((resolve) => setImmediate(resolve));
		}

		if (everyFileSucceeded) {
			await removeMissingFilesAsync(db, new Set(diskFiles));
			setIndexBuildState(db, "complete");
		}
	})();

	const active: ActiveReconcile = { promise: job, subscribers };
	activeReconciles.set(repoRoot, active);
	void job.then(
		() => {
			if (activeReconciles.get(repoRoot) === active) activeReconciles.delete(repoRoot);
		},
		() => {
			if (activeReconciles.get(repoRoot) === active) activeReconciles.delete(repoRoot);
		},
	);
	return job;
}

function reconcileFile(
	db: DatabaseInstance,
	repoRoot: string,
	relPath: string,
	outline: OutlinerFn,
	rebuilding: boolean,
): boolean {
	try {
		const fullPath = path.join(repoRoot, relPath);
		const beforeRead = fs.statSync(fullPath);
		if (!beforeRead.isFile()) return true;
		if (beforeRead.size > MAX_SOURCE_BYTES_FOR_SYMBOLS) {
			const beforeMetadata = metadataFingerprint(beforeRead);
			const afterRead = fs.statSync(fullPath);
			if (!sameFingerprint(beforeMetadata, metadataFingerprint(afterRead))) {
				throw new FileChangedDuringIndexError(relPath);
			}
			if (!rebuilding) {
				const row = db.prepare("SELECT mtime, size, sha FROM files WHERE path = ?").get(relPath) as
					| { mtime: number; size: number; sha: string }
					| undefined;
				const mtimeSec = Math.floor(afterRead.mtimeMs / 1000);
				if (row && row.mtime === mtimeSec && row.size === afterRead.size && row.sha === beforeMetadata.sha) return true;
			}
			indexMetadata(db, relPath, afterRead);
			if (!sameFingerprint(metadataFingerprint(afterRead), metadataFingerprint(fs.statSync(fullPath)))) {
				deleteFileRows(db, relPath);
				throw new FileChangedDuringIndexError(relPath);
			}
			return true;
		}
		const content = fs.readFileSync(fullPath, "utf-8");
		const afterRead = captureFingerprint(fullPath);
		const readFingerprint = fingerprintFromStat(beforeRead, hashContent(content));
		if (!sameFingerprint(readFingerprint, afterRead)) throw new FileChangedDuringIndexError(relPath);

		if (!rebuilding) {
			const row = db.prepare("SELECT mtime, size, sha FROM files WHERE path = ?").get(relPath) as
				| { mtime: number; size: number; sha: string }
				| undefined;
			const mtimeSec = Math.floor(afterRead.mtimeMs / 1000);
			// The stored SHA is the durable part of the fingerprint. Checking it
			// avoids skipping a same-size rewrite within one rounded mtime second.
			if (row && row.mtime === mtimeSec && row.size === afterRead.size && row.sha === afterRead.sha) return true;
		}
		indexFile(db, repoRoot, relPath, content, outline);
		return true;
	} catch (error) {
		// A file removed between git enumeration and processing must not survive
		// the final cleanup: the enumerated path is still in diskFiles. Delete
		// both rows together, while keeping all other failures retryable.
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESTALE") return false;
		if (code === "ENOENT") {
			try {
				deleteFileRows(db, relPath);
				return true;
			} catch {
				return false;
			}
		}
		return false;
	}
}

/**
 * Decode NUL-framed git output only after all byte chunks have been joined.
 * Decoding each chunk separately would corrupt a UTF-8 sequence split by the
 * child-process stream boundary.
 */
export function parseNulSeparatedPathChunks(chunks: readonly Buffer[]): string[] {
	return Buffer.concat(chunks).toString("utf8").split("\0").filter((file) => file.length > 0);
}

/**
 * Asynchronously list all files in a repo, respecting .gitignore.
 * Returns a promise to avoid blocking the event loop.
 */
export async function filterExistingFilesAsync(repoRoot: string, files: readonly string[]): Promise<string[]> {
	const existingFiles: string[] = [];
	for (let start = 0; start < files.length; start += ASYNC_RECONCILE_BATCH_SIZE) {
		const end = Math.min(start + ASYNC_RECONCILE_BATCH_SIZE, files.length);
		const batchFiles = await Promise.all(
			files.slice(start, end).map(async (file) => {
				try {
					return (await fs.promises.stat(path.join(repoRoot, file))).isFile() ? file : null;
				} catch {
					// Tracked-but-deleted paths are not indexable.
					return null;
				}
			}),
		);
		for (const file of batchFiles) {
			if (file !== null) existingFiles.push(file);
		}
		if (end < files.length) await yieldToEventLoop();
	}
	return existingFiles;
}

const GIT_LIST_FILES_TIMEOUT_MS = 5000;

type FileFilter = (repoRoot: string, files: readonly string[]) => Promise<string[]>;

export async function listFilesAsync(
	repoRoot: string,
	childTimeoutMs = GIT_LIST_FILES_TIMEOUT_MS,
	filterFiles: FileFilter = filterExistingFilesAsync,
): Promise<string[]> {
	return new Promise((resolve, reject) => {
		// Include tracked and untracked-but-not-ignored files. NUL framing is
		// required because repository paths may contain newlines.
		const child: ChildProcess = spawn("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
			cwd: repoRoot,
		});

		const stdoutChunks: Buffer[] = [];
		let stderr = "";
		let settled = false;
		const timeout: NodeJS.Timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			const message = `git ls-files timed out after ${childTimeoutMs} ms`;
			console.warn(message);
			reject(new Error(message));
		}, childTimeoutMs);
		const fail = (message: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			console.warn(message);
			reject(new Error(message));
		};

		if (child.stdout) {
			child.stdout.on("data", (data: Buffer) => {
				stdoutChunks.push(data);
			});
		}

		if (child.stderr) {
			child.stderr.on("data", (data: Buffer) => {
				stderr += data.toString();
			});
		}

		child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
			if (settled) return;
			if (code === 0) {
				// The timeout belongs only to the child. Filtering successful output
				// may yield to the event loop and must not be mistaken for a Git hang.
				settled = true;
				clearTimeout(timeout);
				const parsedFiles = parseNulSeparatedPathChunks(stdoutChunks);
				void Promise.resolve().then(() => filterFiles(repoRoot, parsedFiles)).then(resolve, reject);
				return;
			}
			const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
			fail(`git ls-files failed with ${signal ? `signal ${signal}` : `exit code ${code}`}${detail}`);
		});

		child.on("error", (err: Error) => {
			fail(`git ls-files error: ${err.message}`);
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
