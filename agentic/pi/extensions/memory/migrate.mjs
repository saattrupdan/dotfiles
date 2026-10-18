#!/usr/bin/env node
/** Stage and verify an OKF bundle without modifying the source or live target. */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const require = createRequire(import.meta.url);
const { createJiti } = require("../_outliner/node_modules/jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false });

export function inventory(root) {
	const entries = [];
	const walk = (folder, prefix = "") => {
		for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
			const file = path.join(folder, entry.name);
			if (entry.isSymbolicLink()) throw new Error("Bundle contains an unsupported symlink");
			if (entry.isDirectory()) walk(file, `${prefix}${entry.name}/`);
			else if (entry.isFile()) {
				const bytes = fs.readFileSync(file);
				entries.push({ path: prefix + entry.name, size: bytes.length,
					digest: createHash("sha256").update(bytes).digest("hex") });
			} else throw new Error("Bundle contains an unsupported filesystem entry");
		}
	};
	walk(root);
	entries.sort((a, b) => a.path.localeCompare(b.path));
	return { files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
		digest: createHash("sha256").update(JSON.stringify(entries)).digest("hex") };
}

export async function verifyPreservation(source, store, parseConcept) {
	store.reconcile();
	let checked = 0, split = 0;
	const childrenByParent = new Map();
	for (const row of store.db.prepare("SELECT path, raw FROM concepts").all()) {
		const child = parseConcept(row.raw, row.path);
		const parent = child.frontmatter.memory_split_parent;
		if (parent) childrenByParent.set(parent, [...(childrenByParent.get(parent) ?? []), child]);
	}
	const walk = async (dir, prefix = "") => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || (dir === source && ["embeddings", "requests"].includes(entry.name))) continue;
			const full = path.join(dir, entry.name), relative = `${prefix}${entry.name}`;
			if (entry.isDirectory()) { await walk(full, `${relative}/`); continue; }
			if (!entry.name.endsWith(".md") || ["index.md", "log.md"].includes(entry.name)) continue;
			const conceptPath = `/${relative}`;
			const original = parseConcept(fs.readFileSync(full, "utf8"), conceptPath);
			const imported = parseConcept(fs.readFileSync(path.join(store.root, relative), "utf8"), conceptPath);
			if (!isDeepStrictEqual(original.frontmatter, imported.frontmatter)) {
				throw new Error("Imported concept metadata changed unexpectedly");
			}
			if (original.body !== imported.body) {
				const children = (childrenByParent.get(conceptPath) ?? [])
					.sort((a, b) => a.frontmatter.memory_split_index - b.frontmatter.memory_split_index);
				if (!children.length || children.map((child) => child.body).join("") !== original.body) {
					throw new Error("Imported concept body changed unexpectedly");
				}
				split++;
			}
			checked++;
		}
	};
	await walk(source);
	return { checked, split };
}

export async function prepare({ source, stage, embed, progress = () => {} }) {
	if (!fs.statSync(source).isDirectory() || fs.lstatSync(source).isSymbolicLink()) {
		throw new Error("Source must be a real bundle directory");
	}
	if (fs.existsSync(stage)) throw new Error("Migration stage already exists; preserve and inspect it before retrying");
	const before = inventory(source);
	fs.cpSync(source, stage, { recursive: true, errorOnExist: true, force: false });
	const copied = inventory(stage);
	const after = inventory(source);
	if (JSON.stringify(before) !== JSON.stringify(copied) || JSON.stringify(before) !== JSON.stringify(after)) {
		throw new Error("Source changed during migration copy or staged files differ; keep the stage for inspection");
	}
	progress({ phase: "copied", ...before });
	const { MemoryStore, parseConcept } = await jiti.import("./store.ts", { default: false });
	const store = new MemoryStore({ root: stage, ...(embed ? { embed } : {}),
		log: (message) => process.stderr.write(`[migration] ${message}\n`) });
	try {
		let issues = store.lint();
		if (issues.some((issue) => issue.kind === "malformed" || issue.kind === "malformed_embedding")) {
			throw new Error(`Migration contains invalid concepts or embeddings: ${JSON.stringify(counts(issues))}`);
		}
		const oversize = issues.filter((issue) => issue.kind === "oversize");
		for (const issue of oversize) {
			const original = await store.search({ path: issue.path });
			if (!("body" in original)) throw new Error("Oversize concept could not be read");
			const result = await store.update({ path: issue.path, body: original.body });
			if (result.missingEmbeddings.length) throw new Error("Failed to embed a split concept");
		}
		progress({ phase: "split", concepts: oversize.length });
		const rebuilt = await store.rebuildEmbeddings((completed, total) => {
			if (completed % 25 === 0 || completed === total) progress({ phase: "embedding", completed, total });
		});
		issues = store.lint();
		if (rebuilt.missingEmbeddings.length || issues.some((issue) => ["missing_embedding", "stale_embedding", "malformed_embedding", "oversize"].includes(issue.kind))) {
			throw new Error(`Migration has unresolved embeddings or oversize concepts: ${JSON.stringify(counts(issues))}`);
		}
		const preservation = await verifyPreservation(source, store, parseConcept);
		progress({ phase: "preserved", ...preservation });
		const concepts = store.db.prepare("SELECT count(*) AS n FROM concepts").get().n;
		const summary = { source: before, copied, preservation, conceptCount: concepts, splitConcepts: oversize.length,
			vectorsRebuilt: rebuilt.attempted, lint: counts(issues) };
		fs.writeFileSync(path.join(stage, ".migration-report.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
		return summary;
	} finally { store.close(); }
}

function counts(issues) {
	return Object.fromEntries([...new Set(issues.map((issue) => issue.kind))].sort().map((kind) =>
		[kind, issues.filter((issue) => issue.kind === kind).length]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const source = args[args.indexOf("--source") + 1];
	if (!source || !args.includes("--source")) throw new Error("Usage: migrate.mjs --source SOURCE [--inventory | --stage STAGE]");
	if (args.includes("--inventory")) process.stdout.write(`${JSON.stringify(inventory(source), null, 2)}\n`);
	else {
		const stage = args[args.indexOf("--stage") + 1];
		const target = path.join(os.homedir(), "memory", ".migration-stage");
		if (!stage || path.resolve(stage) !== target) throw new Error(`The stage must be ${target}`);
		prepare({ source, stage, progress: (event) => process.stderr.write(`${JSON.stringify(event)}\n`) })
			.then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
			.catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
	}
}
