import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import {
	getFileOutline,
	getIndexDbPath,
	indexFile,
	listFilesAsync,
	openDb,
	parseNulSeparatedPathChunks,
	reconcileIndexAsync,
	refreshFile,
	removeMissingFiles,
	ensureFullIndex,
	filterExistingFilesAsync,
	removeMissingFilesAsync,
	MAX_SOURCE_BYTES_FOR_SYMBOLS,
} from "./index-store.ts";

const makeRepo = (): { root: string; repoId: string; db: ReturnType<typeof Database>; indexDir: string } => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-search-index-"));
	const repoId = `test-${path.basename(root)}`;
	const indexDir = path.dirname(getIndexDbPath(repoId));
	execFileSync("git", ["init", "--quiet", root]);
	return { root, repoId, db: openDb(repoId), indexDir };
};

const closeRepo = (repo: ReturnType<typeof makeRepo>): void => {
	repo.db.close();
	fs.rmSync(repo.root, { recursive: true, force: true });
	fs.rmSync(repo.indexDir, { recursive: true, force: true });
};

const entry = (name: string) => ({
	name,
	kind: "function" as const,
	line: 1,
	lineEnd: 1,
});

test("a failed file replacement rolls back its row and symbols and remains retryable", async () => {
	const repo = makeRepo();
	const file = path.join(repo.root, "one.ts");
	fs.writeFileSync(file, "export function oldName() {}\n");
	execFileSync("git", ["add", "one.ts"], { cwd: repo.root });
	const oldOutline = (_filePath: string, _source: string) => ({ entries: [entry("oldName")] });
	const newOutline = (_filePath: string, _source: string) => ({ entries: [entry("newName")] });

	try {
		indexFile(repo.db, repo.root, "one.ts", fs.readFileSync(file, "utf8"), oldOutline);
		const before = getFileOutline(repo.db, "one.ts");
		assert.equal(before?.entries[0]?.name, "oldName");
		fs.writeFileSync(file, "export function newName() { return 1; }\n");
		repo.db.exec(
			"CREATE TRIGGER injected_failure BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
		);

		await reconcileIndexAsync(repo.db, repo.root, newOutline);
		assert.equal((repo.db.prepare("SELECT value FROM index_meta WHERE key = 'build_state'").get() as { value: string }).value, "incomplete");
		assert.equal(getFileOutline(repo.db, "one.ts")?.entries[0]?.name, "oldName");

		repo.db.exec("DROP TRIGGER injected_failure");
		await reconcileIndexAsync(repo.db, repo.root, newOutline);
		assert.equal((repo.db.prepare("SELECT value FROM index_meta WHERE key = 'build_state'").get() as { value: string }).value, "complete");
		assert.equal(getFileOutline(repo.db, "one.ts")?.entries[0]?.name, "newName");
	} finally {
		closeRepo(repo);
	}
});

test("deletion during reconciliation removes stale rows and completes", async () => {
	const repo = makeRepo();
	const firstFile = path.join(repo.root, "a-first.ts");
	const deletedFile = path.join(repo.root, "z-gone.ts");
	try {
		fs.writeFileSync(firstFile, "export function oldName() {}\n");
		fs.writeFileSync(deletedFile, "export function staleName() {}\n");
		execFileSync("git", ["add", "a-first.ts", "z-gone.ts"], { cwd: repo.root });
		indexFile(repo.db, repo.root, "a-first.ts", fs.readFileSync(firstFile, "utf8"), (_filePath, _source) => ({
			entries: [entry("oldName")],
		}));
		indexFile(repo.db, repo.root, "z-gone.ts", fs.readFileSync(deletedFile, "utf8"), (_filePath, _source) => ({
			entries: [entry("staleName")],
		}));
		fs.writeFileSync(firstFile, "export function newName() { return 1; }\n");

		let deleted = false;
		await reconcileIndexAsync(repo.db, repo.root, (filePath, _source) => {
			if (path.basename(filePath) === "a-first.ts" && !deleted) {
				fs.unlinkSync(deletedFile);
				deleted = true;
			}
			return { entries: [entry("newName")] };
		});

		assert.equal(deleted, true);
		assert.equal(
			(repo.db.prepare("SELECT value FROM index_meta WHERE key = 'build_state'").get() as { value: string }).value,
			"complete",
		);
		assert.equal(repo.db.prepare("SELECT path FROM files WHERE path = 'z-gone.ts'").get(), undefined);
		assert.equal(repo.db.prepare("SELECT file FROM symbols WHERE file = 'z-gone.ts'").get(), undefined);
		assert.equal(getFileOutline(repo.db, "a-first.ts")?.entries[0]?.name, "newName");
	} finally {
		closeRepo(repo);
	}
});

test("same-file deletion during parsing removes rows and keeps the build incomplete", async () => {
	const repo = makeRepo();
	const file = path.join(repo.root, "vanishing.ts");
	try {
		fs.writeFileSync(file, "export function staleName() {}\n");
		execFileSync("git", ["add", "vanishing.ts"], { cwd: repo.root });
		indexFile(repo.db, repo.root, "vanishing.ts", fs.readFileSync(file, "utf8"), (_filePath, _source) => ({
			entries: [entry("staleName")],
		}));

		let parsed = false;
		await reconcileIndexAsync(repo.db, repo.root, (_filePath, _source) => {
			fs.unlinkSync(file);
			parsed = true;
			return { entries: [entry("newName")] };
		});

		assert.equal(parsed, true);
		assert.equal(
			(repo.db.prepare("SELECT value FROM index_meta WHERE key = 'build_state'").get() as { value: string }).value,
			"incomplete",
		);
		assert.equal(repo.db.prepare("SELECT path FROM files WHERE path = 'vanishing.ts'").get(), undefined);
		assert.equal(repo.db.prepare("SELECT file FROM symbols WHERE file = 'vanishing.ts'").get(), undefined);

		await reconcileIndexAsync(repo.db, repo.root, (_filePath, _source) => ({ entries: [] }));
		assert.equal(
			(repo.db.prepare("SELECT value FROM index_meta WHERE key = 'build_state'").get() as { value: string }).value,
			"complete",
		);
	} finally {
		closeRepo(repo);
	}
});

test("delete-then-throw during parsing removes rows and keeps the build incomplete", async () => {
	const repo = makeRepo();
	const file = path.join(repo.root, "throwing.ts");
	try {
		fs.writeFileSync(file, "export function oldName() {}\n");
		const stableMtime = new Date(Math.floor(Date.now() / 1000) * 1000);
		fs.utimesSync(file, stableMtime, stableMtime);
		execFileSync("git", ["add", "throwing.ts"], { cwd: repo.root });
		indexFile(repo.db, repo.root, "throwing.ts", fs.readFileSync(file, "utf8"), (_filePath, _source) => ({
			entries: [entry("oldName")],
		}));
		fs.writeFileSync(file, "export function newName() {}\n");
		fs.utimesSync(file, new Date(stableMtime.getTime() + 1000), new Date(stableMtime.getTime() + 1000));

		await reconcileIndexAsync(repo.db, repo.root, (_filePath, _source) => {
			fs.unlinkSync(file);
			throw new Error("parser failed after delete");
		});

		assert.equal(
			(repo.db.prepare("SELECT value FROM index_meta WHERE key = 'build_state'").get() as { value: string }).value,
			"incomplete",
		);
		assert.equal(repo.db.prepare("SELECT path FROM files WHERE path = 'throwing.ts'").get(), undefined);
		assert.equal(repo.db.prepare("SELECT file FROM symbols WHERE file = 'throwing.ts'").get(), undefined);

		await reconcileIndexAsync(repo.db, repo.root, (_filePath, _source) => ({ entries: [] }));
		assert.equal(
			(repo.db.prepare("SELECT value FROM index_meta WHERE key = 'build_state'").get() as { value: string }).value,
			"complete",
		);
	} finally {
		closeRepo(repo);
	}
});

test("same-size rewrite during parsing is not committed and is retried", async () => {
	const repo = makeRepo();
	const file = path.join(repo.root, "rewritten.ts");
	try {
		fs.writeFileSync(file, "export function oldName() {}\n");
		const stableMtime = new Date(Math.floor(Date.now() / 1000) * 1000);
		fs.utimesSync(file, stableMtime, stableMtime);
		execFileSync("git", ["add", "rewritten.ts"], { cwd: repo.root });
		indexFile(repo.db, repo.root, "rewritten.ts", fs.readFileSync(file, "utf8"), (_filePath, _source) => ({
			entries: [entry("oldName")],
		}));
		fs.writeFileSync(file, "export function newName() {}\n");
		const changedMtime = new Date(stableMtime.getTime() + 1000);
		fs.utimesSync(file, changedMtime, changedMtime);

		await reconcileIndexAsync(repo.db, repo.root, (_filePath, _source) => {
			fs.writeFileSync(file, "export function altName() {}\n");
			fs.utimesSync(file, changedMtime, changedMtime);
			return { entries: [entry("newName")] };
		});

		assert.equal(
			(repo.db.prepare("SELECT value FROM index_meta WHERE key = 'build_state'").get() as { value: string }).value,
			"incomplete",
		);
		assert.equal(getFileOutline(repo.db, "rewritten.ts")?.entries[0]?.name, "oldName");

		await reconcileIndexAsync(repo.db, repo.root, (_filePath, _source) => ({ entries: [entry("altName")] }));
		assert.equal(
			(repo.db.prepare("SELECT value FROM index_meta WHERE key = 'build_state'").get() as { value: string }).value,
			"complete",
		);
		assert.equal(getFileOutline(repo.db, "rewritten.ts")?.entries[0]?.name, "altName");
	} finally {
		closeRepo(repo);
	}
});

test("same-second same-size rewrites are not skipped by reconciliation", async () => {
	const repo = makeRepo();
	const file = path.join(repo.root, "same-second.ts");
	try {
		fs.writeFileSync(file, "export function oldName() {}\n");
		const stableMtime = new Date(Math.floor(Date.now() / 1000) * 1000);
		fs.utimesSync(file, stableMtime, stableMtime);
		execFileSync("git", ["add", "same-second.ts"], { cwd: repo.root });
		indexFile(repo.db, repo.root, "same-second.ts", fs.readFileSync(file, "utf8"), (_filePath, _source) => ({
			entries: [entry("oldName")],
		}));
		fs.writeFileSync(file, "export function newName() {}\n");
		fs.utimesSync(file, stableMtime, stableMtime);

		await reconcileIndexAsync(repo.db, repo.root, (_filePath, _source) => ({ entries: [entry("newName")] }));
		assert.equal(
			(repo.db.prepare("SELECT value FROM index_meta WHERE key = 'build_state'").get() as { value: string }).value,
			"complete",
		);
		assert.equal(getFileOutline(repo.db, "same-second.ts")?.entries[0]?.name, "newName");
	} finally {
		closeRepo(repo);
	}
});

test("refreshFile reindexes same-size edits within the same mtime second", () => {
	const repo = makeRepo();
	const file = path.join(repo.root, "direct.ts");
	try {
		const stableMtime = new Date(Math.floor(Date.now() / 1000) * 1000);
		fs.writeFileSync(file, "export function oldName() {}\n");
		fs.utimesSync(file, stableMtime, stableMtime);
		indexFile(repo.db, repo.root, "direct.ts", fs.readFileSync(file, "utf8"), (_filePath, _source) => ({
			entries: [entry("oldName")],
		}));

		fs.writeFileSync(file, "export function newName() {}\n");
		fs.utimesSync(file, stableMtime, stableMtime);
		assert.equal(
			refreshFile(repo.db, repo.root, "direct.ts", (_filePath, _source) => ({ entries: [entry("newName")] })),
			true,
		);
		assert.equal(getFileOutline(repo.db, "direct.ts")?.entries[0]?.name, "newName");
		assert.equal(
			refreshFile(repo.db, repo.root, "direct.ts", (_filePath, _source) => ({ entries: [entry("newName")] })),
			false,
		);
	} finally {
		closeRepo(repo);
	}
});

test("refreshFile preserves old rows when the source fingerprint changes during parsing", () => {
	const repo = makeRepo();
	const file = path.join(repo.root, "fingerprint.ts");
	try {
		const stableMtime = new Date(Math.floor(Date.now() / 1000) * 1000);
		fs.writeFileSync(file, "export function oldName() {}\n");
		fs.utimesSync(file, stableMtime, stableMtime);
		indexFile(repo.db, repo.root, "fingerprint.ts", fs.readFileSync(file, "utf8"), (_filePath, _source) => ({
			entries: [entry("oldName")],
		}));

		fs.writeFileSync(file, "export function newName() {}\n");
		fs.utimesSync(file, stableMtime, stableMtime);
		assert.equal(
			refreshFile(repo.db, repo.root, "fingerprint.ts", (_filePath, _source) => {
				fs.writeFileSync(file, "export function altName() {}\n");
				fs.utimesSync(file, stableMtime, stableMtime);
				return { entries: [entry("newName")] };
			}),
			false,
		);
		assert.equal(getFileOutline(repo.db, "fingerprint.ts")?.entries[0]?.name, "oldName");

		assert.equal(
			refreshFile(repo.db, repo.root, "fingerprint.ts", (_filePath, _source) => ({ entries: [entry("altName")] })),
			true,
		);
		assert.equal(getFileOutline(repo.db, "fingerprint.ts")?.entries[0]?.name, "altName");
	} finally {
		closeRepo(repo);
	}
});

test("refreshFile rolls back a failed replacement transaction", () => {
	const repo = makeRepo();
	const file = path.join(repo.root, "transaction.ts");
	try {
		fs.writeFileSync(file, "export function oldName() {}\n");
		indexFile(repo.db, repo.root, "transaction.ts", fs.readFileSync(file, "utf8"), (_filePath, _source) => ({
			entries: [entry("oldName")],
		}));
		fs.writeFileSync(file, "export function newName() {}\n");
		repo.db.exec(
			"CREATE TRIGGER injected_failure BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
		);

		assert.equal(
			refreshFile(repo.db, repo.root, "transaction.ts", (_filePath, _source) => ({ entries: [entry("newName")] })),
			false,
		);
		assert.equal(getFileOutline(repo.db, "transaction.ts")?.entries[0]?.name, "oldName");

		repo.db.exec("DROP TRIGGER injected_failure");
		assert.equal(
			refreshFile(repo.db, repo.root, "transaction.ts", (_filePath, _source) => ({ entries: [entry("newName")] })),
			true,
		);
		assert.equal(getFileOutline(repo.db, "transaction.ts")?.entries[0]?.name, "newName");
	} finally {
		closeRepo(repo);
	}
});

test("missing-file cleanup rolls back both rows when symbol deletion fails", () => {
	const repo = makeRepo();
	const file = path.join(repo.root, "one.ts");
	fs.writeFileSync(file, "export function oldName() {}\n");

	try {
		indexFile(repo.db, repo.root, "one.ts", fs.readFileSync(file, "utf8"), (_filePath, _source) => ({
			entries: [entry("oldName")],
		}));
		repo.db.exec(
			"CREATE TRIGGER injected_failure BEFORE DELETE ON symbols BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
		);

		assert.throws(() => removeMissingFiles(repo.db, new Set()), /injected failure/);
		assert.equal(repo.db.prepare("SELECT path FROM files WHERE path = 'one.ts'").get() !== undefined, true);
		assert.equal(repo.db.prepare("SELECT file FROM symbols WHERE file = 'one.ts'").get() !== undefined, true);

		repo.db.exec("DROP TRIGGER injected_failure");
		removeMissingFiles(repo.db, new Set());
		assert.equal(repo.db.prepare("SELECT path FROM files WHERE path = 'one.ts'").get(), undefined);
		assert.equal(repo.db.prepare("SELECT file FROM symbols WHERE file = 'one.ts'").get(), undefined);
	} finally {
		closeRepo(repo);
	}
});

test("large enumeration filtering yields between bounded batches", async () => {
	const repo = makeRepo();
	const fileCount = 401;
	const files = Array.from({ length: fileCount }, (_, index) => `file-${index}.ts`);
	try {
		for (const file of files) fs.writeFileSync(path.join(repo.root, file), "const value = 1;\n");
		let yielded = false;
		const filtering = filterExistingFilesAsync(repo.root, files);
		setImmediate(() => {
			yielded = true;
		});
		const filtered = await filtering;
		assert.equal(yielded, true);
		assert.deepEqual(filtered, files);
	} finally {
		closeRepo(repo);
	}
});

test("large stale-row cleanup yields between bounded deletion batches", async () => {
	const repo = makeRepo();
	const rowCount = 401;
	try {
		const insertFile = repo.db.prepare(
			"INSERT INTO files (path, lines, size, language, sha, mtime, doc) VALUES (?, 1, 1, 'typescript', 'sha', 1, NULL)",
		);
		const insertSymbol = repo.db.prepare(
			"INSERT INTO symbols (name, kind, file, line_start, line_end, parent, signature, doc) VALUES (?, 'function', ?, 1, 1, NULL, NULL, NULL)",
		);
		for (let index = 0; index < rowCount; index += 1) {
			const file = `stale-${index}.ts`;
			insertFile.run(file);
			insertSymbol.run(`stale-${index}`, file);
		}

		let yielded = false;
		const cleanup = removeMissingFilesAsync(repo.db, new Set());
		setImmediate(() => {
			yielded = true;
		});
		assert.equal(await cleanup, rowCount);
		assert.equal(yielded, true);
		assert.equal((repo.db.prepare("SELECT COUNT(*) AS count FROM files").get() as { count: number }).count, 0);
		assert.equal((repo.db.prepare("SELECT COUNT(*) AS count FROM symbols").get() as { count: number }).count, 0);
	} finally {
		closeRepo(repo);
	}
});

test("initial ensure build reports bounded intermediate progress", async () => {
	const repo = makeRepo();
	try {
		for (let i = 0; i < 65; i += 1) fs.writeFileSync(path.join(repo.root, `file-${i}.ts`), `export const file${i} = ${i};\n`);
		execFileSync("git", ["add", "."], { cwd: repo.root });
		const progress: number[] = [];
		const handle = ensureFullIndex(repo.root, (_filePath, _source) => ({ entries: [] }));
		const build = reconcileIndexAsync(handle.db, repo.root, (_filePath, _source) => ({ entries: [] }), (done) => progress.push(done));
		await build;
		assert.ok(progress.some((done) => done > 0 && done < 65));
		assert.equal(progress.at(-1), 65);
	} finally {
		closeRepo(repo);
	}
});

test("concurrent reconcile calls return the identical in-flight promise", async () => {
	const repo = makeRepo();
	try {
		fs.writeFileSync(path.join(repo.root, "file.ts"), "export const value = 1;\n");
		const first = reconcileIndexAsync(repo.db, repo.root, (_filePath, _source) => ({ entries: [] }));
		const second = reconcileIndexAsync(repo.db, repo.root, (_filePath, _source) => ({ entries: [] }));
		assert.strictEqual(second, first);
		await first;
	} finally {
		closeRepo(repo);
	}
});

test("schema 7 rows are migrated, but an incompatible unversioned schema is rebuilt", () => {
	const repo = makeRepo();
	closeRepo(repo);
	const dbPath = getIndexDbPath(repo.repoId);
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const legacy = new Database(dbPath);
	legacy.exec(`
		CREATE TABLE files (path TEXT PRIMARY KEY, lines INTEGER, size INTEGER, language TEXT, sha TEXT, mtime INTEGER, doc TEXT);
		CREATE TABLE symbols (name TEXT, kind TEXT, file TEXT, line_start INTEGER, line_end INTEGER, parent TEXT, signature TEXT, doc TEXT, PRIMARY KEY (name, file, line_start));
		INSERT INTO files VALUES ('kept.ts', 1, 1, 'typescript', 'known', 1, NULL);
		PRAGMA user_version = 7;
	`);
	legacy.close();
	const migrated = openDb(repo.repoId);
	assert.equal(migrated.prepare("SELECT sha FROM files WHERE path = 'kept.ts'").get() !== undefined, true);
	migrated.close();

	const incompatible = new Database(dbPath);
	incompatible.exec("DROP TABLE files; DROP TABLE symbols; DROP TABLE index_meta;");
	incompatible.exec("CREATE TABLE files (path TEXT PRIMARY KEY, hash TEXT); CREATE TABLE symbols (name TEXT);");
	incompatible.exec("INSERT INTO files VALUES ('stale.ts', 'old'); PRAGMA user_version = 0;");
	incompatible.close();
	const rebuilt = openDb(repo.repoId);
	assert.equal(rebuilt.prepare("SELECT * FROM files WHERE path = 'stale.ts'").get(), undefined);
	assert.deepEqual(
		(rebuilt.pragma("user_version", { simple: true }) as number),
		8,
	);
	rebuilt.close();
	fs.rmSync(repo.root, { recursive: true, force: true });
	fs.rmSync(repo.indexDir, { recursive: true, force: true });
});

test("malformed metadata is rebuilt for schema 0 and schema 7", () => {
	for (const version of [0, 7]) {
		const repo = makeRepo();
		closeRepo(repo);
		const dbPath = getIndexDbPath(repo.repoId);
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const legacy = new Database(dbPath);
		legacy.exec(`
			CREATE TABLE files (path TEXT PRIMARY KEY, lines INTEGER, size INTEGER, language TEXT, sha TEXT, mtime INTEGER, doc TEXT);
			CREATE TABLE symbols (name TEXT, kind TEXT, file TEXT, line_start INTEGER, line_end INTEGER, parent TEXT, signature TEXT, doc TEXT, PRIMARY KEY (name, file, line_start));
			CREATE TABLE index_meta (key TEXT PRIMARY KEY, payload TEXT);
			INSERT INTO files VALUES ('stale.ts', 1, 1, 'typescript', 'stale', 1, NULL);
			INSERT INTO index_meta VALUES ('build_state', 'complete');
			PRAGMA user_version = ${version};
		`);
		legacy.close();

		const rebuilt = openDb(repo.repoId);
		assert.equal(rebuilt.prepare("SELECT * FROM files WHERE path = 'stale.ts'").get(), undefined);
		assert.equal(
			(rebuilt.prepare("SELECT value FROM index_meta WHERE key = 'build_state'").get() as { value: string }).value,
			"incomplete",
		);
		rebuilt.close();
		fs.rmSync(repo.root, { recursive: true, force: true });
		fs.rmSync(repo.indexDir, { recursive: true, force: true });
	}
});

test("split UTF-8 git output remains NUL-safe", () => {
	const filename = "føniks\nnotes.ts";
	const output = Buffer.from(`${filename}\0plain.ts\0`, "utf8");
	const splitAt = output.indexOf(Buffer.from("ø", "utf8")) + 1;
	assert.deepEqual(parseNulSeparatedPathChunks([output.subarray(0, splitAt), output.subarray(splitAt)]), [filename, "plain.ts"]);
});

test("Git failure rejects and leaves reconciliation incomplete for retry", async () => {
	const repo = makeRepo();
	try {
		await assert.rejects(listFilesAsync(path.join(repo.root, "missing")), /git ls-files error|failed/);
		repo.db.prepare("UPDATE index_meta SET value = 'complete' WHERE key = 'build_state'").run();
		const build = reconcileIndexAsync(repo.db, path.join(repo.root, "missing"), (_filePath, _source) => ({ entries: [] }));
		await assert.rejects(build, /git ls-files error|failed/);
		assert.equal((repo.db.prepare("SELECT value FROM index_meta WHERE key = 'build_state'").get() as { value: string }).value, "incomplete");
	} finally {
		closeRepo(repo);
	}
});

test("Git timeout rejects without falling back to a synchronous walk", async () => {
	const repo = makeRepo();
	try {
		await assert.rejects(listFilesAsync(repo.root, 0), /git ls-files timed out/);
	} finally {
		closeRepo(repo);
	}
});

test("successful Git output is not replaced while asynchronous filtering is slow", async () => {
	const repo = makeRepo();
	try {
		fs.writeFileSync(path.join(repo.root, "tracked.ts"), "const tracked = true;\n");
		fs.writeFileSync(path.join(repo.root, ".gitignore"), "ignored.ts\n");
		fs.writeFileSync(path.join(repo.root, "ignored.ts"), "const ignored = true;\n");
		execFileSync("git", ["add", "."], { cwd: repo.root });
		const slowFilter = async (root: string, files: readonly string[]): Promise<string[]> => {
			await new Promise<void>((resolve) => setTimeout(resolve, 100));
			return filterExistingFilesAsync(root, files);
		};
		assert.deepEqual(await listFilesAsync(repo.root, 50, slowFilter), [".gitignore", "tracked.ts"]);
	} finally {
		closeRepo(repo);
	}
});

test("oversized files receive metadata rows without invoking the outliner", async () => {
	const repo = makeRepo();
	const file = path.join(repo.root, "huge.ts");
	try {
		fs.writeFileSync(file, Buffer.alloc(MAX_SOURCE_BYTES_FOR_SYMBOLS + 1, 0x78));
		execFileSync("git", ["add", "huge.ts"], { cwd: repo.root });
		let calls = 0;
		await reconcileIndexAsync(repo.db, repo.root, () => {
			calls += 1;
			throw new Error("oversized source was parsed");
		});
		assert.equal(calls, 0);
		assert.equal((repo.db.prepare("SELECT size FROM files WHERE path = 'huge.ts'").get() as { size: number }).size, MAX_SOURCE_BYTES_FOR_SYMBOLS + 1);
		assert.equal(repo.db.prepare("SELECT file FROM symbols WHERE file = 'huge.ts'").get(), undefined);
		assert.equal((repo.db.prepare("SELECT value FROM index_meta WHERE key = 'build_state'").get() as { value: string }).value, "complete");
		await reconcileIndexAsync(repo.db, repo.root, () => {
			calls += 1;
			throw new Error("oversized source was parsed on retry");
		});
		assert.equal(calls, 0);

		fs.writeFileSync(file, "export function recovered() {}\n");
		await reconcileIndexAsync(repo.db, repo.root, (_filePath, _source) => ({ entries: [entry("recovered")] }));
		assert.equal(getFileOutline(repo.db, "huge.ts")?.entries[0]?.name, "recovered");
		assert.equal((repo.db.prepare("SELECT value FROM index_meta WHERE key = 'build_state'").get() as { value: string }).value, "complete");
	} finally {
		closeRepo(repo);
	}
});

test("git enumeration is NUL-safe, omits deleted tracked files, and honors empty results", async () => {
	const repo = makeRepo();
	try {
		fs.writeFileSync(path.join(repo.root, "line\nbreak.ts"), "const value = 1;\n");
		fs.writeFileSync(path.join(repo.root, "deleted.ts"), "const deleted = true;\n");
		fs.writeFileSync(path.join(repo.root, ".gitignore"), "ignored.ts\n");
		fs.writeFileSync(path.join(repo.root, "ignored.ts"), "const ignored = true;\n");
		execFileSync("git", ["add", "."], { cwd: repo.root });
		fs.unlinkSync(path.join(repo.root, "deleted.ts"));
		assert.deepEqual(await listFilesAsync(repo.root), [".gitignore", "line\nbreak.ts"]);
	} finally {
		closeRepo(repo);
	}

	const empty = makeRepo();
	try {
		fs.writeFileSync(path.join(empty.root, ".gitignore"), "*\n");
		fs.writeFileSync(path.join(empty.root, "ignored.ts"), "ignored\n");
		assert.deepEqual(await listFilesAsync(empty.root), []);
	} finally {
		closeRepo(empty);
	}
});
