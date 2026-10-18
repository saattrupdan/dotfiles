/** Bounded, local OKF overview for main's startup prompt. No Understory dependency. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const YAML = require("../memory/node_modules/yaml");
const MAX_ROWS = 20;
const MAX_TYPES = 12;
const MAX_AREAS = 8;
export const DEFAULT_ROOT = path.join(os.homedir(), "memory");
export const DEFAULT_PATHS = {
	cacheFile: path.join(DEFAULT_ROOT, ".snapshot", "cache.json"),
	snapshotFile: path.join(DEFAULT_ROOT, ".snapshot", "current.md"),
};

function cell(value) {
	return String(value ?? "").replace(/[\r\n|\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

export function collectConcepts(root = DEFAULT_ROOT) {
	const concepts = [];
	const walk = (folder, area = "") => {
		for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || ["index.md", "log.md"].includes(entry.name) ||
				(!area && ["requests", "embeddings"].includes(entry.name))) continue;
			if (entry.isSymbolicLink()) throw new Error("Snapshot source contains a symlink");
			const file = path.join(folder, entry.name);
			if (entry.isDirectory()) { walk(file, area || entry.name); continue; }
			if (!entry.name.endsWith(".md")) continue;
			const raw = fs.readFileSync(file, "utf8");
			const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n){1,2}/.exec(raw);
			if (!match) throw new Error("Snapshot source has malformed concept frontmatter");
			const metadata = YAML.parse(match[1]);
			if (!metadata || typeof metadata.type !== "string" || !metadata.type.trim()) {
				throw new Error("Snapshot source has a concept without a type");
			}
			if (metadata.memory_split_parent) continue;
			concepts.push({ title: cell(metadata.title ?? entry.name.slice(0, -3)), type: cell(metadata.type),
				description: cell(metadata.description), area: cell(area || "root"), mtime: fs.statSync(file).mtimeMs });
		}
	};
	walk(root);
	return concepts;
}

export function renderNativeSnapshot(concepts) {
	const counts = (key, limit) => [...concepts.reduce((map, concept) => {
		const name = concept[key]; map.set(name, (map.get(name) ?? 0) + 1); return map;
	}, new Map())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit)
		.map(([name, count]) => `${name} (${count})`).join(", ") || "none";
	const rows = [...concepts].sort((a, b) => b.mtime - a.mtime || a.title.localeCompare(b.title))
		.slice(0, MAX_ROWS).map((concept) => `| ${concept.title} | ${concept.type} | ${concept.area} | ${concept.description} |`);
	return [
		`Concepts: ${concepts.length}. Types: ${counts("type", MAX_TYPES)}.`,
		`Areas: ${counts("area", MAX_AREAS)}.`,
		"", "| Recent concept | Type | Area | Description |", "|---|---|---|---|", ...rows,
		"", "→ Use recall_memory to search and read cited concepts before acting on relevant tasks.",
	].join("\n");
}

export function readCache(file) {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		return typeof value.snapshot === "string" && Number.isSafeInteger(value.updatedAt) ? value : null;
	} catch { return null; }
}
function writeAtomic(file, contents) {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.tmp`;
	try { fs.writeFileSync(temp, contents, { flag: "wx", mode: 0o600 }); fs.renameSync(temp, file); }
	finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

export function buildSnapshotSection(snapshot, updatedAt) {
	return `## Memory — Current Contents (auto-generated)\n\n*Updated: ${new Date(updatedAt).toISOString()}*\n\n${snapshot}`;
}

export async function refreshCache({ root = DEFAULT_ROOT, paths = root === DEFAULT_ROOT ? DEFAULT_PATHS : {
	cacheFile: path.join(root, ".snapshot", "cache.json"),
	snapshotFile: path.join(root, ".snapshot", "current.md"),
}, now = Date.now() } = {}) {
	const previous = readCache(paths.cacheFile);
	const saved = new Map();
	for (const file of [paths.cacheFile, paths.snapshotFile]) {
		try { saved.set(file, fs.readFileSync(file, "utf8")); } catch { /* First refresh. */ }
	}
	try {
		const snapshot = renderNativeSnapshot(collectConcepts(root));
		const cache = { snapshot, updatedAt: now };
		writeAtomic(paths.cacheFile, `${JSON.stringify(cache)}\n`);
		writeAtomic(paths.snapshotFile, buildSnapshotSection(snapshot, now));
		return { refreshed: true, cache };
	} catch (error) {
		for (const file of [paths.cacheFile, paths.snapshotFile]) {
			try {
				if (saved.has(file)) writeAtomic(file, saved.get(file));
				else fs.rmSync(file, { force: true });
			} catch { /* Preserve whichever last-known-good file remains. */ }
		}
		return { refreshed: false, cache: previous, error };
	}
}

export function restoreSnapshotFromCache(paths, cache) {
	if (!cache || fs.existsSync(paths.snapshotFile)) return false;
	writeAtomic(paths.snapshotFile, buildSnapshotSection(cache.snapshot, cache.updatedAt));
	return true;
}
