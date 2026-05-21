/**
 * SQLite-backed index store for the search extension.
 *
 * Manages two tables:
 * - `files`   — file manifest (path, lines, size, language, sha, mtime)
 * - `symbols` — extracted symbols (name, kind, file, line_start, line_end, parent)
 *
 * Each repo gets its own index.db under `~/.pi/index/<repo-id>/`.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";

import type Database from "better-sqlite3";
import type { OutlineEntry } from "../_outliner/outliner.js";

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
		const output = execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8" });
		const root = output.trim();
		return sha1(root);
	} catch {
		// Try git-common-dir for worktrees
		try {
			const out = execSync("git rev-parse --git-common-dir", { cwd, encoding: "utf-8" });
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
export function openDb(repoId: string): Database.Database {
	const dbPath = getIndexDbPath(repoId);
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const db = require("better-sqlite3")(dbPath);

	db.exec(`
		CREATE TABLE IF NOT EXISTS files (
			path    TEXT PRIMARY KEY,
			lines   INTEGER,
			size    INTEGER,
			language TEXT,
			sha     TEXT,
			mtime   INTEGER
		);

		CREATE TABLE IF NOT EXISTS symbols (
			name       TEXT,
			kind       TEXT,
			file       TEXT,
			line_start INTEGER,
			line_end   INTEGER,
			parent     TEXT,
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
export function rebuildIndex(db: Database.Database, repoId: string, repoRoot: string): void {
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
	db: Database.Database,
	relativePath: string,
	lines: number,
	size: number,
	language: string,
	sha: string,
	mtime: number,
): void {
	const stmt = db.prepare(
		`INSERT OR REPLACE INTO files (path, lines, size, language, sha, mtime)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	);
	stmt.run(relativePath, lines, size, language, sha, mtime);
}

/**
 * Insert a symbol row into the index.
 */
export function insertSymbol(
	db: Database.Database,
	entry: OutlineEntry,
	file: string,
): void {
	const stmt = db.prepare(
		`INSERT OR REPLACE INTO symbols (name, kind, file, line_start, line_end, parent)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	);
	stmt.run(entry.name, entry.kind, file, entry.line, entry.line, entry.parent ?? null);
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

export function querySymbols(db: Database.Database, query: string): SymbolResult[] {
	const stmt = db.prepare(
		`SELECT name, kind, file, line_start, line_end, parent
		 FROM symbols
		 WHERE name LIKE ?
		 ORDER BY kind = 'class' OR kind = 'function' DESC`,
	);
	const results = stmt.all(`%${query}%`);
	return results as unknown as SymbolResult[];
}

/**
 * Query files for exact name match (for promotion).
 */
export function queryExactSymbol(db: Database.Database, query: string): SymbolResult[] {
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
export function removeMissingFiles(db: Database.Database, existingPaths: Set<string>): void {
	const stmt = db.prepare("SELECT path FROM files");
	const rows = stmt.all() as { path: string }[];
	const toDelete = rows
		.filter((r) => !existingPaths.has(r.path))
		.map((r) => r.path);

	if (toDelete.length === 0) return;

	const stmt2 = db.prepare("DELETE FROM files WHERE path = ?");
	for (const p of toDelete) {
		stmt2.run(p);
	}

	const stmt3 = db.prepare("DELETE FROM symbols WHERE file = ?");
	for (const p of toDelete) {
		stmt3.run(p);
	}
}

/**
 * Incrementally update: stat every file in the DB, re-parse only changed ones.
 * Returns the set of existing file paths.
 */
export function incrementalRefresh(
	db: Database.Database,
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
			updateFile(relPath);
		} catch {
			// Silently skip
		}
	}

	// Remove missing files
	removeMissingFiles(db, existingPaths);

	return existingPaths;
}

// ---------------------------------------------------------------------------
// File tree traversal
// ---------------------------------------------------------------------------

/**
 * Recursively list all files in a directory tree, skipping .git/, node_modules/, .pi/index/.
 */
export function listFiles(repoRoot: string): string[] {
	const results: string[] = [];
	const skipDirs = new Set([".git", "node_modules", ".pi"]);

	function walk(dir: string): void {
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
	}

	walk(repoRoot);
	return results;
}
