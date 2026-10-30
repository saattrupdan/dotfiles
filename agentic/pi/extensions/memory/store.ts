/** OKF concepts are authoritative Markdown. The SQLite search index is disposable. */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import YAML from "yaml";
import { Index, MetricKind, ScalarKind } from "usearch";

import { createEmbedder, DIMENSIONS, type Embed, MODEL } from "./embedding.ts";

const MAX_CONCEPT_BYTES = 24_000;
const MAX_PART_BYTES = 19_000;
const RRF_K = 60;
const CANDIDATES = 40;
const LINK = /\]\(([^)#?\s]+\.md)(?:[?#][^)]*)?\)/g;
const RESERVED = new Set(["index.md", "log.md"]);
const RESERVED_ROOT_DIRECTORIES = new Set(["embeddings", "requests"]);

type Metadata = Record<string, unknown> & { type: string; title?: string; description?: string; tags?: string[] };
type Concept = { path: string; frontmatter: Metadata; body: string; raw: string };
type Indexed = { path: string; hash: string; title: string; body: string; raw: string };
type EmbeddingRow = { path: string; hash: string; model: string; vector: Buffer };

export type ConceptInput = {
	path: string;
	type: string;
	title?: string;
	description?: string;
	tags?: string[];
	body: string;
};
export type ConceptUpdate = Omit<Partial<ConceptInput>, "path"> & { path: string; body: string };
export type LintIssue = { kind: string; path: string; detail: string };
export type SearchResult = {
	path: string;
	type: string;
	title: string;
	snippet: string;
	score: number;
	matchedBy: string[];
};

function hash(raw: string): string {
	return createHash("sha256").update(raw).digest("hex");
}

export function parseConcept(raw: string, conceptPath: string): Concept {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n){1,2}/.exec(raw);
	if (!match) throw new Error("missing YAML frontmatter");
	const data: unknown = YAML.parse(match[1]);
	if (!data || typeof data !== "object" || Array.isArray(data) ||
		typeof (data as Metadata).type !== "string" || !(data as Metadata).type.trim()) {
		throw new Error("frontmatter needs a nonempty type");
	}
	return { path: conceptPath, frontmatter: data as Metadata, body: raw.slice(match[0].length), raw };
}

function serialize(metadata: Metadata, body: string): string {
	return `---\n${YAML.stringify(metadata).trimEnd()}\n---\n\n${body}`;
}

/** Conservative byte bound is below 32,768 tokenizer tokens, even with byte fallback. */
function splitBody(body: string): string[] {
	const chars = Array.from(body);
	const parts: string[] = [];
	for (let start = 0; start < chars.length;) {
		let end = start;
		let bytes = 0;
		while (end < chars.length) {
			const size = Buffer.byteLength(chars[end]);
			if (bytes + size > MAX_PART_BYTES) break;
			bytes += size;
			end++;
		}
		if (end < chars.length) {
			for (let i = end - 1; i > start + 8_000; i--) {
				if (/\s/u.test(chars[i])) { end = i + 1; break; }
			}
		}
		if (end <= start) throw new Error("Unable to split concept body");
		parts.push(chars.slice(start, end).join(""));
		start = end;
	}
	return parts;
}

function normalizeLink(source: string, target: string): string | null {
	let decoded: string;
	try { decoded = decodeURIComponent(target); } catch { return null; }
	const segments = (decoded.startsWith("/") ? decoded : `${path.posix.dirname(source)}/${decoded}`)
		.split("/");
	const resolved: string[] = [];
	for (const segment of segments) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (!resolved.length) return null;
			resolved.pop();
		} else {
			resolved.push(segment);
		}
	}
	return `/${resolved.join("/")}`;
}

function cosine(a: number[], b: Buffer): number {
	if (b.length !== a.length * 4) return -Infinity;
	let dot = 0, an = 0, bn = 0;
	for (let i = 0; i < a.length; i++) {
		const v = b.readFloatLE(i * 4);
		dot += a[i] * v;
		an += a[i] * a[i];
		bn += v * v;
	}
	return an && bn ? dot / Math.sqrt(an * bn) : -Infinity;
}

export class MemoryStore {
	readonly root: string;
	readonly db: ReturnType<typeof Database>;
	private readonly lockPath: string;
	private readonly snapshotFile: string;
	private snapshotStamp: string | null = null;
	private snapshotRows: EmbeddingRow[] = [];
	private embeddingError: LintIssue | null = null;
	private indexGeneration = 0;
	private annGeneration = -1;
	private ann: Index | undefined;
	private annPaths: string[] = [];
	private readonly embed: Embed;
	private readonly archiveUpdates: boolean;
	private readonly log: (message: string) => void;

	constructor(options: {
		root?: string;
		embed?: Embed;
		archiveUpdates?: boolean;
		log?: (message: string) => void;
	} = {}) {
		const root = path.resolve(options.root ?? path.join(os.homedir(), "memory"));
		if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Memory bundle is missing: ${root}`);
		if (fs.lstatSync(root).isSymbolicLink()) throw new Error("Memory bundle root must not be a symlink");
		this.root = fs.realpathSync(root);
		this.snapshotFile = path.join(this.root, "embeddings.sqlite");
		this.embed = options.embed ?? createEmbedder();
		this.archiveUpdates = options.archiveUpdates ?? true;
		this.log = options.log ?? ((message) => console.error(`[pi-memory] ${message}`));
		this.lockPath = path.join(this.root, ".write.lock");
		const obsolete = path.join(this.root, "search.sqlite");
		const old = fs.lstatSync(obsolete, { throwIfNoEntry: false });
		if (old && !old.isFile()) throw new Error("Obsolete search index must be a regular file");
		if (old) fs.unlinkSync(obsolete);
		this.db = Database(":memory:");
		this.db.exec(`
			CREATE TABLE concepts (path TEXT PRIMARY KEY, hash TEXT NOT NULL,
				title TEXT NOT NULL, body TEXT NOT NULL, raw TEXT NOT NULL);
			CREATE VIRTUAL TABLE concepts_fts USING fts5(path UNINDEXED, title, body);
		`);
	}

	close(): void { this.db.close(); }

	private resolve(conceptPath: string, allowReserved = false): string {
		if (!conceptPath.startsWith("/") || !conceptPath.endsWith(".md") || conceptPath.includes("\0") ||
			conceptPath.includes("\\")) throw new Error(`Invalid bundle path: ${conceptPath}`);
		const parts = conceptPath.slice(1).split("/");
		if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".")) ||
			RESERVED_ROOT_DIRECTORIES.has(parts[0]) || (!allowReserved && RESERVED.has(parts[parts.length - 1]))) {
			throw new Error(`Invalid concept path: ${conceptPath}`);
		}
		let target = this.root;
		for (const part of parts) {
			target = path.join(target, part);
			if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
				throw new Error(`Symlinks are not allowed in the memory bundle: ${conceptPath}`);
			}
		}
		return target;
	}

	private checkReservedFiles(): void {
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if ((entry.name === "index.md" || (dir === this.root && entry.name === "log.md")) && entry.isSymbolicLink()) {
					throw new Error(`Reserved OKF file must not be a symlink: ${entry.name}`);
				}
				if (entry.isDirectory() && !entry.name.startsWith(".") &&
					!(dir === this.root && RESERVED_ROOT_DIRECTORIES.has(entry.name))) {
					walk(path.join(dir, entry.name));
				}
			}
		};
		walk(this.root);
	}

	private files(): string[] {
		const result: string[] = [];
		const walk = (dir: string, prefix: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (entry.isSymbolicLink() || entry.name.startsWith(".") ||
					(dir === this.root && RESERVED_ROOT_DIRECTORIES.has(entry.name))) continue;
				const rel = `${prefix}/${entry.name}`;
				if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
				else if (entry.isFile() && entry.name.endsWith(".md") && !RESERVED.has(entry.name)) result.push(rel);
			}
		};
		walk(this.root, "");
		return result.sort();
	}

	/** Reconcile after hand edits, restored bundles, and interrupted operations. */
	reconcile(): LintIssue[] {
		const invalid: LintIssue[] = [];
		const paths = new Set<string>();
		let changed = false;
		const put = this.db.prepare(`INSERT INTO concepts (path, hash, title, body, raw) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, title=excluded.title,
			body=excluded.body, raw=excluded.raw`);
		const clearFts = this.db.prepare("DELETE FROM concepts_fts WHERE path = ?");
		const addFts = this.db.prepare("INSERT INTO concepts_fts (path, title, body) VALUES (?, ?, ?)");
		for (const p of this.files()) {
			paths.add(p);
			let concept: Concept;
			try { concept = parseConcept(fs.readFileSync(this.resolve(p), "utf8"), p); }
			catch (error) {
				invalid.push({ kind: "malformed", path: p, detail: (error as Error).message });
				changed = true;
				this.db.prepare("DELETE FROM concepts WHERE path = ?").run(p);
				clearFts.run(p);
				continue;
			}
			const digest = hash(concept.raw);
			const current = this.db.prepare("SELECT hash FROM concepts WHERE path = ?").get(p) as { hash: string } | undefined;
			if (current?.hash === digest) continue;
			changed = true;
			const title = concept.frontmatter.title ?? path.posix.basename(p, ".md");
			this.db.transaction(() => {
				put.run(p, digest, String(title), concept.body, concept.raw);
				clearFts.run(p);
				addFts.run(p, String(title), concept.body);
			})();
		}
		for (const row of this.db.prepare("SELECT path FROM concepts").all() as Array<{ path: string }>) {
			if (!paths.has(row.path)) {
				changed = true;
				this.db.transaction(() => {
					this.db.prepare("DELETE FROM concepts WHERE path = ?").run(row.path);
					clearFts.run(row.path);
				})();
			}
		}
		if (changed) {
			this.rebuildIndexes();
			this.indexGeneration++;
		}
		invalid.push(...this.syncEmbeddings());
		return invalid;
	}

	private atomicWrite(conceptPath: string, raw: string): void {
		const target = this.resolve(conceptPath);
		this.atomicWriteFile(target, raw);
	}

	private atomicWriteFile(target: string, raw: string): void {
		fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
		const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		try {
			fs.writeFileSync(temp, raw, { flag: "wx", mode: 0o600 });
			fs.renameSync(temp, target);
		} finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
	}

	private snapshotVersion(): string | null {
		const info = fs.lstatSync(this.snapshotFile, { throwIfNoEntry: false });
		if (!info) return null;
		if (!info.isFile()) throw new Error("Embedding snapshot must be a regular SQLite file");
		const stamp = fs.statSync(this.snapshotFile, { bigint: true });
		return `${stamp.mtimeNs}:${stamp.size}`;
	}

	/** Publish the only persisted vector store as a complete SQLite snapshot. */
	private publishSnapshot(updates: EmbeddingRow[] = [], removals: string[] = []): void {
		// Another process may have published a snapshot while this writer awaited the lock.
		if (this.snapshotVersion() && this.syncEmbeddings().some((issue) => issue.kind === "malformed_embedding")) {
			throw new Error("Embedding snapshot is invalid; repair it before writing concepts");
		}
		const vectors = new Map(this.snapshotRows.map((row) => [row.path, row]));
		for (const removed of removals) vectors.delete(removed);
		for (const row of updates) vectors.set(row.path, row);
		const temp = path.join(this.root, `.embeddings-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
		let output: ReturnType<typeof Database> | undefined;
		try {
			output = Database(temp);
			output.pragma("journal_mode = DELETE");
			output.pragma("synchronous = FULL");
			output.exec("CREATE TABLE embeddings (path TEXT PRIMARY KEY, hash TEXT NOT NULL, model TEXT NOT NULL, vector BLOB NOT NULL)");
			const add = output.prepare("INSERT INTO embeddings (path, hash, model, vector) VALUES (?, ?, ?, ?)");
			output.transaction(() => {
				for (const row of vectors.values()) add.run(row.path, row.hash, row.model, row.vector);
			})();
			output.close();
			output = undefined;
			fs.chmodSync(temp, 0o600);
			const descriptor = fs.openSync(temp, "r");
			try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
			this.snapshotVersion(); // Reject an existing symlink or non-file before renaming.
			fs.renameSync(temp, this.snapshotFile);
			this.snapshotRows = [...vectors.values()];
			this.snapshotStamp = this.snapshotVersion();
			this.embeddingError = null;
			this.indexGeneration++;
		} finally {
			output?.close();
			if (fs.existsSync(temp)) fs.unlinkSync(temp);
		}
	}

	/** One-time import of the earlier JSON layouts; keep the files on any failure. */
	private importLegacyEmbeddings(): boolean {
		const imported = new Map<string, EmbeddingRow>();
		const directories = [path.join(this.root, ".embeddings"), path.join(this.root, "embeddings")];
		let found = false;
		for (const directory of directories) {
			const info = fs.lstatSync(directory, { throwIfNoEntry: false });
			if (!info) continue;
			if (!info.isDirectory()) throw new Error(`Legacy embedding path is not a directory: ${directory}`);
			found = true;
			const visit = (folder: string): void => {
				for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
					const file = path.join(folder, entry.name);
					if (entry.isDirectory() && directory.endsWith("/embeddings")) visit(file);
					else if (entry.isFile() && entry.name.endsWith(".json")) {
						const saved = JSON.parse(fs.readFileSync(file, "utf8")) as {
							path: string; hash: string; model: string; vector: number[];
						};
						this.resolve(saved.path);
						const expected = directory.endsWith("/.embeddings")
							? path.join(directory, `${hash(saved.path)}.json`)
							: path.join(directory, `${saved.path.slice(1, -3)}.json`);
						if (file !== expected || typeof saved.hash !== "string" || typeof saved.model !== "string" ||
							!Array.isArray(saved.vector) || saved.vector.length !== DIMENSIONS ||
							saved.vector.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
							throw new Error(`Invalid legacy embedding: ${file}`);
						}
						const bytes = Buffer.allocUnsafe(DIMENSIONS * 4);
						saved.vector.forEach((value, i) => bytes.writeFloatLE(value, i * 4));
						imported.set(saved.path, { path: saved.path, hash: saved.hash, model: saved.model, vector: bytes });
					} else throw new Error(`Unexpected legacy embedding entry: ${file}`);
				}
			};
			visit(directory);
		}
		if (found) {
			this.publishSnapshot([...imported.values()]);
			for (const directory of directories) {
				if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true });
			}
		}
		return found;
	}

	/** Load the backed-up vector snapshot into memory, never into the FTS5 database. */
	private syncEmbeddings(): LintIssue[] {
		let version: string | null;
		try { version = this.snapshotVersion(); }
		catch (error) {
			this.snapshotRows = [];
			this.embeddingError = { kind: "malformed_embedding", path: "/embeddings.sqlite", detail: (error as Error).message };
			return [this.embeddingError];
		}
		if (version && version === this.snapshotStamp || !version && this.snapshotStamp === "missing") {
			return this.embeddingError ? [this.embeddingError] : [];
		}
		try {
			if (!version) {
				if (!this.importLegacyEmbeddings()) {
					this.snapshotRows = [];
					this.snapshotStamp = "missing";
				}
			} else {
				const source = Database(this.snapshotFile, { readonly: true, fileMustExist: true });
				try {
					if (source.pragma("quick_check", { simple: true }) !== "ok") throw new Error("embedding snapshot failed integrity check");
					const rows = source.prepare("SELECT path, hash, model, vector FROM embeddings").all() as EmbeddingRow[];
					for (const row of rows) {
						this.resolve(row.path);
						if (row.vector.length !== DIMENSIONS * 4) throw new Error(`Invalid vector: ${row.path}`);
					}
					this.snapshotRows = rows;
					this.snapshotStamp = version;
				} finally { source.close(); }
			}
			this.embeddingError = null;
			this.indexGeneration++;
			return [];
		} catch (error) {
			this.snapshotRows = [];
			this.snapshotStamp = version;
			this.embeddingError = { kind: "malformed_embedding", path: "/embeddings.sqlite", detail: (error as Error).message };
			return [this.embeddingError];
		}
	}

	private rebuildIndexes(): void {
		const write = (dir: string): number => {
			const entries = fs.readdirSync(dir, { withFileTypes: true })
				.filter((entry) => !entry.name.startsWith(".") && !entry.isSymbolicLink() &&
					!(dir === this.root && RESERVED_ROOT_DIRECTORIES.has(entry.name)))
				.sort((a, b) => a.name.localeCompare(b.name));
			const concepts: string[] = [];
			const directories: string[] = [];
			let total = 0;
			for (const entry of entries) {
				if (entry.isDirectory()) {
					const count = write(path.join(dir, entry.name));
					total += count;
					directories.push(`* [${entry.name}](${entry.name}/) - ${count} concept${count === 1 ? "" : "s"}`);
				} else if (entry.isFile() && entry.name.endsWith(".md") && !RESERVED.has(entry.name)) {
					total++;
					const rel = `/${path.relative(this.root, path.join(dir, entry.name)).split(path.sep).join("/")}`;
					let title = entry.name.slice(0, -3), description = "";
					try {
						const metadata = parseConcept(fs.readFileSync(path.join(dir, entry.name), "utf8"), rel).frontmatter;
						title = metadata.title ?? title;
						description = metadata.description ?? "";
					} catch { /* Index malformed files by filename; lint reports them. */ }
					concepts.push(`* [${title}](${encodeURI(entry.name)})${description ? ` - ${description}` : ""}`);
				}
			}
			const root = dir === this.root;
			const header = root ? '---\nokf_version: "0.1"\n---\n\n' : "";
			const name = root ? "Knowledge Base" : path.basename(dir);
			const body = `${header}<!-- pi-memory-index -->\n\n# ${name}\n\n` +
				(concepts.length ? `${concepts.join("\n")}\n\n` : "") +
				(directories.length ? `## ${root ? "Memory Segments" : "Subdirectories"}\n\n${directories.join("\n")}\n` : "");
			const file = path.join(dir, "index.md");
			const existing = fs.lstatSync(file, { throwIfNoEntry: false });
			if (existing?.isSymbolicLink()) throw new Error(`Index must not be a symlink: ${file}`);
			if (!existing || fs.readFileSync(file, "utf8").includes("<!-- pi-memory-index -->")) {
				this.atomicWriteFile(file, body);
			}
			return total;
		};
		write(this.root);
	}

	private appendLog(action: "Creation" | "Update" | "Deletion", conceptPath: string): void {
		const file = path.join(this.root, "log.md");
		const today = new Date().toISOString().slice(0, 10);
		const heading = `## ${today}`;
		const bullet = `* **${action}**: ${conceptPath}`;
		const existing = fs.lstatSync(file, { throwIfNoEntry: false });
		if (existing?.isSymbolicLink()) throw new Error("Memory log must not be a symlink");
		const previous = existing ? fs.readFileSync(file, "utf8") : "";
		let content: string;
		if (!previous.trim()) content = `# Directory Update Log\n\n${heading}\n\n${bullet}\n`;
		else if (previous.includes(heading)) content = previous.replace(heading, `${heading}\n\n${bullet}`);
		else content = previous.replace("# Directory Update Log", `# Directory Update Log\n\n${heading}\n\n${bullet}`);
		this.atomicWriteFile(file, content);
	}

	private pruneEmptyDirs(dir = this.root): void {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory() && !entry.name.startsWith(".") &&
					!(dir === this.root && RESERVED_ROOT_DIRECTORIES.has(entry.name))) this.pruneEmptyDirs(path.join(dir, entry.name));
		}
		if (dir === this.root) return;
		const remaining = fs.readdirSync(dir);
		if (remaining.length === 0 || (remaining.length === 1 && remaining[0] === "index.md")) {
			if (remaining.length) fs.unlinkSync(path.join(dir, "index.md"));
			fs.rmdirSync(dir);
		}
	}

	private async withWriteLock<T>(action: () => Promise<T>): Promise<T> {
		let acquired = false;
		for (let attempt = 0; attempt < 200; attempt++) {
			try {
				fs.writeFileSync(this.lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
				acquired = true;
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				try {
					const owner = Number(fs.readFileSync(this.lockPath, "utf8"));
					if (Number.isInteger(owner) && owner > 0) {
						try { process.kill(owner, 0); }
						catch (check) {
							if ((check as NodeJS.ErrnoException).code === "ESRCH") {
								fs.unlinkSync(this.lockPath);
								continue;
							}
						}
					}
				} catch (check) {
					if ((check as NodeJS.ErrnoException).code !== "ENOENT") throw check;
				}
				if (attempt === 199) throw new Error("Memory bundle is busy (write lock timed out)", { cause: error });
				await new Promise((done) => setTimeout(done, 100));
			}
		}
		if (!acquired) throw new Error("Memory bundle is busy");
		try { return await action(); }
		finally { fs.unlinkSync(this.lockPath); }
	}

	private generatedParts(parent: string): string[] {
		const rows = this.db.prepare("SELECT path, raw FROM concepts").all() as Array<{ path: string; raw: string }>;
		return rows.filter((row) => parseConcept(row.raw, row.path).frontmatter.memory_split_parent === parent)
			.map((row) => row.path).sort();
	}

	private materialize(conceptPath: string, metadata: Metadata, body: string): Array<{ path: string; raw: string }> {
		const raw = serialize(metadata, body);
		if (Buffer.byteLength(raw) <= MAX_CONCEPT_BYTES) return [{ path: conceptPath, raw }];
		const parts = splitBody(body);
		if (parts.length < 2) throw new Error("Concept metadata exceeds the embedding budget");
		const prefix = conceptPath.slice(0, -3);
		const children = parts.map((part, index) => {
			const childPath = `${prefix}-part-${String(index + 1).padStart(3, "0")}.md`;
			return {
				path: childPath,
				raw: serialize({ type: metadata.type, title: `${metadata.title ?? prefix} (part ${index + 1})`,
					memory_split_parent: conceptPath, memory_split_index: index + 1 }, part),
			};
		});
		const intro = `This concept is split into ${children.length} parts:\n\n` +
			children.map((child, i) => `- [Part ${i + 1}](${child.path})`).join("\n");
		const output = [...children, { path: conceptPath, raw: serialize(metadata, intro) }];
		for (const part of output) {
			if (Buffer.byteLength(part.raw) > MAX_CONCEPT_BYTES) throw new Error(`Concept part exceeds embedding budget: ${part.path}`);
		}
		return output;
	}

	private async embedDocuments(documents: Array<{ path: string; raw: string }>,
		onProgress?: (completed: number, total: number) => void): Promise<string[]> {
		const failures: string[] = [];
		let completed = 0;
		for (const document of documents) {
			try {
				const parsed = parseConcept(document.raw, document.path);
				const vector = await this.embed(`${parsed.frontmatter.title ?? document.path}\n${parsed.body}`, "document");
				if (vector.length !== DIMENSIONS || vector.some((v) => !Number.isFinite(v))) throw new Error("invalid embedding dimensions");
				const bytes = Buffer.allocUnsafe(DIMENSIONS * 4);
				for (let i = 0; i < vector.length; i++) bytes.writeFloatLE(vector[i], i * 4);
				const digest = hash(document.raw);
				await this.withWriteLock(async () => {
					const file = this.resolve(document.path);
					if (fs.existsSync(file) && hash(fs.readFileSync(file, "utf8")) === digest) {
						this.publishSnapshot([{ path: document.path, hash: digest, model: MODEL, vector: bytes }]);
					}
				});
			} catch (error) {
				failures.push(document.path);
				this.log(`embedding failed for ${document.path}: ${(error as Error).message}`);
			} finally { onProgress?.(++completed, documents.length); }
		}
		return failures;
	}

	private async write(input: ConceptInput | ConceptUpdate, create: boolean): Promise<{
		paths: string[]; missingEmbeddings: string[]; archive?: string
	}> {
		const { documents, archive } = await this.withWriteLock(async () => {
			this.checkReservedFiles();
			if (this.reconcile().some((issue) => issue.kind === "malformed_embedding")) {
				throw new Error("Embedding snapshot is invalid; repair it before writing concepts");
			}
			const target = this.resolve(input.path);
			const exists = fs.existsSync(target);
			if (create === exists) throw new Error(create ? `Concept already exists: ${input.path}` : `Concept not found: ${input.path}`);
			const previous = exists ? parseConcept(fs.readFileSync(target, "utf8"), input.path) : undefined;
			if (previous?.frontmatter.memory_split_parent) throw new Error("Update the parent concept instead of a generated part");
			const metadata = { ...(previous?.frontmatter ?? {}), type: input.type ?? previous?.frontmatter.type,
				...(input.title !== undefined ? { title: input.title } : {}),
				...(input.description !== undefined ? { description: input.description } : {}),
				...(input.tags !== undefined ? { tags: input.tags } : {}) } as Metadata;
			if (typeof metadata.type !== "string" || !metadata.type.trim()) throw new Error("Concept needs a nonempty type");
			if (typeof input.body !== "string" || !input.body.trim()) throw new Error("Concept body must not be empty");
			if (Buffer.byteLength(YAML.stringify(metadata)) > 4_096) throw new Error("Concept metadata exceeds the embedding budget");
			const documents = this.materialize(input.path, metadata, input.body);
			const oldParts = previous ? this.generatedParts(input.path) : [];
			for (const document of documents) {
				this.resolve(document.path);
				if (document.path !== input.path && !oldParts.includes(document.path) &&
					fs.existsSync(this.resolve(document.path))) throw new Error(`Generated part path already exists: ${document.path}`);
			}
			const archive = previous && this.archiveUpdates
				? this.archiveConcepts([input.path, ...oldParts], "versions") : undefined;
			for (const document of documents) this.atomicWrite(document.path, document.raw);
			const removedParts = oldParts.filter((part) => !documents.some((doc) => doc.path === part));
			for (const removed of removedParts) fs.unlinkSync(this.resolve(removed));
			if (removedParts.length) this.publishSnapshot([], removedParts);
			this.reconcile();
			this.appendLog(create ? "Creation" : "Update", input.path);
			return { documents, archive };
		});
		return { paths: documents.map((doc) => doc.path), missingEmbeddings: await this.embedDocuments(documents),
			...(archive ? { archive } : {}) };
	}

	/** Rebuild vectors for a restored bundle without rewriting any concept Markdown. */
	async rebuildEmbeddings(onProgress?: (completed: number, total: number) => void): Promise<{
		attempted: number; missingEmbeddings: string[]
	}> {
		if (this.reconcile().some((issue) => issue.kind === "malformed_embedding")) {
			throw new Error("Embedding snapshot is invalid; repair it before rebuilding vectors");
		}
		const vectors = new Map(this.snapshotRows.map((row) => [row.path, row]));
		const documents = (this.db.prepare("SELECT path, raw, hash FROM concepts ORDER BY path").all() as Array<Pick<Indexed, "path" | "raw" | "hash">>)
			.filter((row) => {
				const current = vectors.get(row.path);
				return !current || current.hash !== row.hash || current.model !== MODEL;
			});
		return { attempted: documents.length, missingEmbeddings: await this.embedDocuments(documents, onProgress) };
	}

	/** Preserve malformed originals byte-for-byte in the version archive before making them searchable. */
	async repairMalformed(): Promise<{ repaired: number; archives: string[]; missingEmbeddings: string[] }> {
		const paths = this.reconcile().filter((issue) => issue.kind === "malformed").map((issue) => issue.path);
		const archives: string[] = [], missingEmbeddings: string[] = [];
		for (const conceptPath of paths) {
			const result = await this.withWriteLock(async () => {
				this.checkReservedFiles();
				if (this.reconcile().some((issue) => issue.kind === "malformed_embedding")) {
					throw new Error("Embedding snapshot is invalid; repair it before repairing concepts");
				}
				const target = this.resolve(conceptPath);
				if (!fs.existsSync(target)) return undefined;
				const raw = fs.readFileSync(target, "utf8");
				try { parseConcept(raw, conceptPath); return undefined; }
				catch { /* Preserve unreadable frontmatter in the recovered body. */ }
				const body = raw || "Original concept file was empty.\n";
				const documents = this.materialize(conceptPath, { type: "Note",
					title: path.posix.basename(conceptPath, ".md") }, body);
				for (const document of documents) {
					if (document.path !== conceptPath && fs.existsSync(this.resolve(document.path))) {
						throw new Error(`Generated part path already exists: ${document.path}`);
					}
				}
				const archive = this.archiveConcepts([conceptPath], "versions");
				for (const document of documents) this.atomicWrite(document.path, document.raw);
				this.reconcile();
				this.appendLog("Update", conceptPath);
				return { documents, archive };
			});
			if (!result) continue;
			archives.push(result.archive);
			missingEmbeddings.push(...await this.embedDocuments(result.documents));
		}
		return { repaired: archives.length, archives, missingEmbeddings };
	}

	/** Connect orphan concepts through a navigational catalog without changing their facts. */
	async repairOrphans(): Promise<{ catalog?: string; linked: number; archive?: string }> {
		const orphans = this.lint().filter((issue) => issue.kind === "orphan").map((issue) => issue.path);
		if (!orphans.length) return { linked: 0 };
		const rows = this.db.prepare("SELECT path, raw FROM concepts ORDER BY path").all() as Array<{ path: string; raw: string }>;
		const catalogTag = "pi-memory-catalog";
		const existing = rows.find((row) => {
			const tags = parseConcept(row.raw, row.path).frontmatter.tags;
			return Array.isArray(tags) && tags.includes(catalogTag);
		});
		let catalog = existing?.path;
		if (!catalog) {
			for (let n = 1; ; n++) {
				const candidate = `/notes/pi-memory-catalog${n === 1 ? "" : `-${n}`}.md`;
				if (!fs.existsSync(this.resolve(candidate))) { catalog = candidate; break; }
			}
		}
		const targets = rows.filter((row) => row.path !== catalog &&
			parseConcept(row.raw, row.path).frontmatter.memory_split_parent !== catalog)
			.map((row) => row.path);
		const body = `# Memory catalog\n\nNavigation links to stored concepts.\n\n` +
			targets.map((target) => {
				const label = path.posix.basename(target, ".md").replaceAll("[", "\\[").replaceAll("]", "\\]");
				const href = target.split("/").map((segment) => encodeURIComponent(segment)
					.replaceAll("(", "%28").replaceAll(")", "%29")).join("/");
				return `- [${label}](${href})`;
			}).join("\n") + "\n";
		let archive: string | undefined;
		if (existing) {
			if (parseConcept(existing.raw, existing.path).body !== body) {
				archive = (await this.update({ path: catalog!, body })).archive;
			}
		} else {
			await this.create({ path: catalog!, type: "Index", title: "Memory catalog",
				body, tags: [catalogTag] });
		}
		const editable = rows.filter((row) => row.path !== catalog &&
			!parseConcept(row.raw, row.path).frontmatter.memory_split_parent);
		const anchor = orphans.find((orphan) => editable.some((row) => row.path === orphan)) ?? editable[0]?.path;
		if (!anchor) throw new Error("No editable concept can link the catalog");
		const source = rows.find((row) => row.path === anchor)!;
		const parsed = parseConcept(source.raw, anchor);
		if (!parsed.body.includes(`](${catalog})`)) {
			const updated = await this.update({ path: anchor,
				body: `${parsed.body.trimEnd()}\n\nSee [Memory catalog](${catalog}).\n` });
			archive = updated.archive ?? archive;
		}
		return { catalog, linked: orphans.length, archive };
	}

	/** Repair vectors unattended; never discard a vector while its Markdown still exists. */
	async repairEmbeddings(): Promise<{ attempted: number; missingEmbeddings: string[]; pruned: string[];
		snapshotArchive?: string }> {
		const snapshotArchive = await this.withWriteLock(async () => {
			if (!this.reconcile().some((issue) => issue.kind === "malformed_embedding")) return undefined;
			const source = this.snapshotFile;
			const info = fs.lstatSync(source, { throwIfNoEntry: false });
			if (!info?.isFile()) throw new Error("Invalid embedding snapshot is not a regular file");
			const queue = path.join(this.root, "requests");
			const folder = path.join(queue, "snapshot-backups");
			for (const directory of [queue, folder]) {
				const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
				if (existing && !existing.isDirectory()) throw new Error("Snapshot archive must be a real directory");
				if (!existing) fs.mkdirSync(directory, { mode: 0o700 });
			}
			const archive = path.join(folder, `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}.sqlite`);
			fs.renameSync(source, archive);
			return `/requests/snapshot-backups/${path.basename(archive)}`;
		});
		const rebuilt = await this.rebuildEmbeddings();
		const pruned = await this.withWriteLock(async () => {
			if (this.reconcile().some((issue) => issue.kind === "malformed_embedding")) {
				throw new Error("Embedding snapshot is invalid; repair it before pruning vectors");
			}
			const absent = this.snapshotRows.map((row) => row.path)
				.filter((conceptPath) => !fs.existsSync(this.resolve(conceptPath)));
			if (absent.length) this.publishSnapshot([], absent);
			return absent;
		});
		return { ...rebuilt, pruned, ...(snapshotArchive ? { snapshotArchive } : {}) };
	}

	create(input: ConceptInput): Promise<{ paths: string[]; missingEmbeddings: string[] }> { return this.write(input, true); }
	update(input: ConceptUpdate): Promise<{ paths: string[]; missingEmbeddings: string[]; archive?: string }> {
		return this.write(input, false);
	}

	private archiveConcepts(paths: string[], category: "removed" | "versions"): string {
		const queue = path.join(this.root, "requests");
		const base = path.join(queue, category);
		for (const folder of [queue, base]) {
			const existing = fs.lstatSync(folder, { throwIfNoEntry: false });
			if (existing && !existing.isDirectory()) throw new Error("Memory removal archive must be a real directory");
			if (!existing) fs.mkdirSync(folder, { mode: 0o700 });
		}
		const id = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
		const folder = path.join(base, id);
		fs.mkdirSync(folder, { mode: 0o700 });
		const entries = paths.map((conceptPath) => {
			const raw = fs.readFileSync(this.resolve(conceptPath), "utf8");
			const file = `${hash(conceptPath)}.md`;
			this.atomicWriteFile(path.join(folder, file), raw);
			return { path: conceptPath, file, sha256: hash(raw) };
		});
		this.atomicWriteFile(path.join(folder, "manifest.json"), `${JSON.stringify({ createdAt: new Date().toISOString(), entries }, null, 2)}\n`);
		return `/requests/${category}/${id}`;
	}

	/** A scheduled deletion is safe only if another concept retains the exact same facts and metadata. */
	private isExactDuplicate(conceptPath: string): boolean {
		const row = this.db.prepare("SELECT raw FROM concepts WHERE path = ?").get(conceptPath) as { raw: string } | undefined;
		if (!row) return false;
		return !!this.db.prepare("SELECT 1 FROM concepts WHERE raw = ? AND path != ? LIMIT 1").get(row.raw, conceptPath);
	}

	async remove(conceptPath: string, scheduled = false): Promise<{ removed: string[]; archive: string }> {
		return this.withWriteLock(async () => {
			this.checkReservedFiles();
			if (this.reconcile().some((issue) => issue.kind === "malformed_embedding")) {
				throw new Error("Embedding snapshot is invalid; repair it before removing concepts");
			}
			const target = this.resolve(conceptPath);
			if (!fs.existsSync(target)) throw new Error(`Concept not found: ${conceptPath}`);
			if (scheduled && (!this.lint().some((issue) => issue.kind === "orphan" && issue.path === conceptPath) ||
				!this.isExactDuplicate(conceptPath))) {
				throw new Error("Hourly cleanup can remove only unlinked exact duplicates");
			}
			if (parseConcept(fs.readFileSync(target, "utf8"), conceptPath).frontmatter.memory_split_parent) {
				throw new Error("Remove the parent concept instead of a generated part");
			}
			const paths = [conceptPath, ...this.generatedParts(conceptPath)];
			const archive = this.archiveConcepts(paths, "removed");
			for (const p of paths) fs.unlinkSync(this.resolve(p));
			this.db.transaction(() => {
				for (const p of paths) {
					this.db.prepare("DELETE FROM concepts WHERE path = ?").run(p);
					this.db.prepare("DELETE FROM concepts_fts WHERE path = ?").run(p);
				}
			})();
			this.publishSnapshot([], paths);
			this.pruneEmptyDirs();
			this.rebuildIndexes();
			this.appendLog("Deletion", conceptPath);
			return { removed: paths, archive };
		});
	}

	private nearestPaths(vector: number[]): string[] {
		const indexed = new Map((this.db.prepare("SELECT path, hash FROM concepts").all() as Array<{ path: string; hash: string }>)
			.map((row) => [row.path, row.hash]));
		const rows = this.snapshotRows.filter((row) => row.model === MODEL && indexed.get(row.path) === row.hash)
			.sort((a, b) => a.path.localeCompare(b.path));
		if (!rows.length) return [];
		try {
			if (this.annGeneration !== this.indexGeneration) {
				const ann = new Index({ dimensions: DIMENSIONS, metric: MetricKind.Cos,
					quantization: ScalarKind.F32, connectivity: 16, expansion_add: 64,
					expansion_search: 64, multi: false });
				rows.forEach((row, i) => {
					if (row.vector.length !== DIMENSIONS * 4) throw new Error(`Invalid vector: ${row.path}`);
					const values = Float32Array.from({ length: DIMENSIONS }, (_, n) => row.vector.readFloatLE(n * 4));
					ann.add(BigInt(i + 1), values);
				});
				this.ann = ann;
				this.annPaths = rows.map((row) => row.path);
				this.annGeneration = this.indexGeneration;
			}
			const matches = this.ann!.search(new Float32Array(vector), Math.min(rows.length, CANDIDATES), 0);
			return Array.from(matches.keys, (key) => this.annPaths[Number(key) - 1]).filter((p): p is string => !!p);
		} catch (error) {
			this.log(`ANN index failed; using exact cosine: ${(error as Error).message}`);
			return rows.map((row) => ({ path: row.path, score: cosine(vector, row.vector) }))
				.filter((row) => Number.isFinite(row.score))
				.sort((a, b) => b.score - a.score).slice(0, CANDIDATES).map((row) => row.path);
		}
	}

	async search(options: { query?: string; path?: string; limit?: number }): Promise<
		{ path: string; frontmatter: Metadata; body: string } | { results: SearchResult[]; embeddingFallback: boolean }
	> {
		const indexIssues = this.reconcile();
		if (options.path !== undefined) {
			this.resolve(options.path);
			const row = this.db.prepare("SELECT raw FROM concepts WHERE path = ?").get(options.path) as { raw: string } | undefined;
			if (!row) throw new Error(`Concept not found: ${options.path}`);
			const concept = parseConcept(row.raw, options.path);
			return { path: options.path, frontmatter: concept.frontmatter, body: concept.body };
		}
		const query = options.query?.trim();
		if (!query) throw new Error("Provide a query or an exact bundle path");
		const limit = Math.max(1, Math.min(options.limit ?? 10, 25));
		const ranks = new Map<string, { score: number; matchedBy: string[] }>();
		const add = (conceptPath: string, rank: number, source: string): void => {
			const existing = ranks.get(conceptPath) ?? { score: 0, matchedBy: [] };
			existing.score += 1 / (RRF_K + rank);
			existing.matchedBy.push(source);
			ranks.set(conceptPath, existing);
		};
		const words = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 16);
		if (words.length) {
			const fts = words.map((word) => `"${word}"`).join(" OR ");
			const rows = this.db.prepare(`SELECT path FROM concepts_fts WHERE concepts_fts MATCH ?
				ORDER BY bm25(concepts_fts, 0, 4, 1) LIMIT ?`).all(fts, CANDIDATES) as Array<{ path: string }>;
			rows.forEach((row, i) => add(row.path, i + 1, "bm25"));
		}
		let embeddingFallback = false;
		try {
			if (indexIssues.some((issue) => issue.kind === "malformed_embedding")) {
				throw new Error("Embedding snapshot is invalid");
			}
			const vector = await this.embed(query, "query");
			if (vector.length !== DIMENSIONS || vector.some((v) => !Number.isFinite(v))) throw new Error("invalid embedding dimensions");
			this.nearestPaths(vector).forEach((conceptPath, i) => add(conceptPath, i + 1, "embedding"));
		} catch (error) {
			embeddingFallback = true;
			this.log(`query embedding failed; using BM25 only: ${(error as Error).message}`);
		}
		const results = [...ranks.entries()].sort((a, b) => b[1].score - a[1].score)
			.slice(0, limit).flatMap(([p, rank]) => {
				const row = this.db.prepare("SELECT raw FROM concepts WHERE path = ?").get(p) as { raw: string } | undefined;
				if (!row) return [];
				const concept = parseConcept(row.raw, p);
				return [{ path: p, type: concept.frontmatter.type, title: concept.frontmatter.title ?? p,
					snippet: concept.body.slice(0, 500), score: rank.score, matchedBy: rank.matchedBy }];
			});
		return { results, embeddingFallback };
	}

	lint(): LintIssue[] {
		const issues = this.reconcile();
		const concepts = (this.db.prepare("SELECT path, hash, raw FROM concepts").all() as Array<Indexed>)
			.map((row) => ({ ...row, parsed: parseConcept(row.raw, row.path) }));
		const known = new Set(concepts.map((concept) => concept.path));
		const inbound = new Map(concepts.map((concept) => [concept.path, 0]));
		const embeddings = new Map(this.snapshotRows.map((row) => [row.path, row]));
		for (const concept of concepts) {
			if (Buffer.byteLength(concept.raw) > MAX_CONCEPT_BYTES) issues.push({ kind: "oversize", path: concept.path,
				detail: `More than ${MAX_CONCEPT_BYTES} bytes; must be split before embedding` });
			const embedding = embeddings.get(concept.path);
			if (!embedding) issues.push({ kind: "missing_embedding", path: concept.path, detail: "No embedding" });
			else if (embedding.hash !== concept.hash || embedding.model !== MODEL || embedding.vector.length !== DIMENSIONS * 4) {
				issues.push({ kind: "stale_embedding", path: concept.path, detail: "Content, model or vector size changed" });
			}
			const repeated = new Map<string, number>();
			for (const paragraph of concept.parsed.body.split(/\n\s*\n/)) {
				const normalized = paragraph.replace(/\s+/g, " ").trim().toLowerCase();
				if (normalized.length < 40) continue;
				const seen = repeated.get(normalized) ?? 0;
				if (seen === 1) issues.push({ kind: "duplicate_text", path: concept.path,
					detail: `Repeated paragraph: ${normalized.slice(0, 100)}` });
				repeated.set(normalized, seen + 1);
			}
			const targets = new Set<string>();
			for (const match of concept.parsed.body.matchAll(LINK)) {
				const target = normalizeLink(concept.path, match[1]);
				if (!target || (!known.has(target) && !RESERVED.has(path.posix.basename(target)))) {
					issues.push({ kind: "broken_link", path: concept.path, detail: match[1] });
					continue;
				}
				if (RESERVED.has(path.posix.basename(target))) {
					if (!fs.existsSync(path.join(this.root, target.slice(1)))) issues.push({ kind: "broken_link", path: concept.path, detail: match[1] });
					continue;
				}
				if (target !== concept.path) targets.add(target);
			}
			for (const target of targets) inbound.set(target, (inbound.get(target) ?? 0) + 1);
		}
		for (const [p, count] of inbound) {
			if (!count) issues.push({ kind: "orphan", path: p, detail: "No inbound concept link" });
		}
		for (const p of embeddings.keys()) {
			if (!known.has(p)) issues.push({ kind: "orphan_embedding", path: p, detail: "No matching concept" });
		}
		return issues.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
	}
}
