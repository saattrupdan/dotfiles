#!/usr/bin/env node
/**
 * Deterministic Understory memory snapshot refresh.
 *
 * This is deliberately a plain Node script: the snapshot is a local cache of
 * Understory's tree API, not an MCP or LLM request.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const UNDERSTORY_URL = "http://localhost:3800/api/tree";
export const CACHE_TTL_MS = 15 * 60 * 1000;
export const CHECK_INTERVAL_MS = 5 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 10 * 1000;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
export const DEFAULT_PATHS = {
	cacheFile: path.join(AGENT_DIR, "memory-snapshot.json"),
	snapshotFile: path.join(AGENT_DIR, "memory-snapshot.md"),
};

const TABLE_HEADER = [
	"| Entity | Type | What's Stored |",
	"|--------|------|---------------|",
];
const MEMORY_QUERY_REMINDER = "→ Query before acting on any task touching these entities. Use memory_query(\"question about <Entity>\").";

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value) {
	return typeof value === "string";
}

/**
 * Validate the response shape and return the tree root. Keeping validation
 * separate makes it impossible for a partial tree to replace the cache.
 */
export function validateTree(value) {
	if (!isRecord(value)) throw new Error("Tree response must be an object");
	validateNode(value, "$");
	return value;
}

function validateNode(value, location) {
	if (!isRecord(value)) throw new Error(`${location} must be an object`);
	for (const field of ["name", "path", "kind"]) {
		if (!isString(value[field]) || value[field].length === 0) {
			throw new Error(`${location}.${field} must be a non-empty string`);
		}
	}
	if (!["directory", "concept", "reserved"].includes(value.kind)) {
		throw new Error(`${location}.kind is invalid`);
	}
	if (value.kind === "concept") {
		if (!isString(value.type) || value.type.length === 0) {
			throw new Error(`${location}.type must be a non-empty string`);
		}
		if (!isString(value.description)) {
			throw new Error(`${location}.description must be a string`);
		}
		if (value.title !== undefined && !isString(value.title)) {
			throw new Error(`${location}.title must be a string`);
		}
	}
	if (value.children !== undefined) {
		if (!Array.isArray(value.children)) throw new Error(`${location}.children must be an array`);
		value.children.forEach((child, index) => validateNode(child, `${location}.children[${index}]`));
	}
}

function compareStrings(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function flattenConcepts(root) {
	const concepts = [];
	function visit(node) {
		if (node.kind === "concept") concepts.push(node);
		for (const child of node.children ?? []) visit(child);
	}
	visit(root);
	return concepts.sort((left, right) => {
		const byPath = compareStrings(left.path, right.path);
		if (byPath !== 0) return byPath;
		const leftTitle = left.title ?? left.name;
		const rightTitle = right.title ?? right.name;
		return compareStrings(
			`${leftTitle}\u0000${left.type}\u0000${left.description}`,
			`${rightTitle}\u0000${right.type}\u0000${right.description}`,
		);
	});
}

export function escapeTableCell(value) {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll("|", "\\|")
		.replaceAll("\r\n", "<br>")
		.replaceAll("\n", "<br>")
		.replaceAll("\r", "<br>");
}

export function renderSnapshot(tree) {
	const rows = flattenConcepts(tree).map((concept) => {
		const title = concept.title ?? concept.name;
		return `| ${escapeTableCell(title)} | ${escapeTableCell(concept.type)} | ${escapeTableCell(concept.description)} |`;
	});
	return [...TABLE_HEADER, ...rows, "", MEMORY_QUERY_REMINDER].join("\n");
}

export function buildSnapshotSection(snapshot, updatedAt) {
	return [
		"## Memory — Current Contents (auto-generated)",
		"",
		`*Last memory activity: ${formatRelativeTime(updatedAt)}*`,
		"",
		snapshot,
	].join("\n");
}

export function formatRelativeTime(timestamp, now = Date.now()) {
	if (!timestamp || timestamp === 0) return "unknown";
	const diffSec = Math.floor((now - timestamp) / 1000);
	const diffMin = Math.floor(diffSec / 60);
	const diffHour = Math.floor(diffMin / 60);
	const diffDay = Math.floor(diffHour / 24);
	if (diffDay >= 1) return `${diffDay} day${diffDay > 1 ? "s" : ""} ago`;
	if (diffHour >= 1) return `${diffHour} hour${diffHour > 1 ? "s" : ""} ago`;
	if (diffMin >= 1) return `${diffMin} minute${diffMin > 1 ? "s" : ""} ago`;
	return "just now";
}

function readCache(cacheFile) {
	try {
		const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
		if (!isRecord(cache) || typeof cache.snapshot !== "string" || typeof cache.updatedAt !== "number") return null;
		return cache;
	} catch {
		return null;
	}
}

async function readResponseBody(response, maxBytes) {
	const contentLength = response.headers?.get?.("content-length");
	if (contentLength && Number(contentLength) > maxBytes) throw new Error("Tree response is too large");
	if (!response.body) {
		const text = await response.text();
		if (Buffer.byteLength(text) > maxBytes) throw new Error("Tree response is too large");
		return text;
	}
	const reader = response.body.getReader();
	const chunks = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				throw new Error("Tree response is too large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function fetchTree({
	fetchImpl = globalThis.fetch,
	url = UNDERSTORY_URL,
	timeoutMs = REQUEST_TIMEOUT_MS,
	maxBytes = MAX_RESPONSE_BYTES,
} = {}) {
	if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(url, { method: "GET", signal: controller.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const body = await readResponseBody(response, maxBytes);
		let tree;
		try {
			tree = JSON.parse(body);
		} catch {
			throw new Error("Tree response is not valid JSON");
		}
		return validateTree(tree);
	} finally {
		clearTimeout(timeout);
	}
}

function writeAtomic(file, content) {
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(temporary, content, "utf8");
		fs.renameSync(temporary, file);
	} finally {
		try { fs.unlinkSync(temporary); } catch {}
	}
}

function writeFilesAtomically({ cacheFile, snapshotFile }, snapshot, updatedAt) {
	const cacheText = `${JSON.stringify({ snapshot, updatedAt }, null, 2)}\n`;
	const snapshotText = buildSnapshotSection(snapshot, updatedAt);
	const previous = new Map();
	for (const file of [cacheFile, snapshotFile]) {
		try { previous.set(file, fs.readFileSync(file, "utf8")); } catch {}
	}
	fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
	fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
	try {
		writeAtomic(cacheFile, cacheText);
		writeAtomic(snapshotFile, snapshotText);
	} catch (error) {
		// Revert the first rename if the second file cannot be replaced.
		for (const file of [cacheFile, snapshotFile]) {
			if (previous.has(file)) writeAtomic(file, previous.get(file));
			else try { fs.unlinkSync(file); } catch {}
		}
		throw error;
	}
}

function restoreSnapshotFromCache(paths, cache) {
	if (cache && !fs.existsSync(paths.snapshotFile)) {
		writeAtomic(paths.snapshotFile, buildSnapshotSection(cache.snapshot, cache.updatedAt));
	}
}

export async function refreshCache({
	paths = DEFAULT_PATHS,
	now = Date.now(),
	fetchOptions,
} = {}) {
	const disk = readCache(paths.cacheFile);
	if (disk && now - disk.updatedAt <= CACHE_TTL_MS) {
		restoreSnapshotFromCache(paths, disk);
		return { refreshed: false, cache: disk };
	}
	try {
		const tree = await fetchTree(fetchOptions);
		const snapshot = renderSnapshot(tree);
		const updatedAt = now;
		writeFilesAtomically(paths, snapshot, updatedAt);
		return { refreshed: true, cache: { snapshot, updatedAt } };
	} catch (error) {
		// A failed request must not replace either last-known-good file. Startup's
		// existing cache repair behavior is retained only when the snapshot is
		// missing altogether.
		restoreSnapshotFromCache(paths, disk);
		return { refreshed: false, cache: disk, error };
	}
}

export async function runOnce(options = {}) {
	return refreshCache(options);
}

export async function runDaemon(options = {}) {
	await refreshCache(options);
	while (true) {
		await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
		await refreshCache(options);
	}
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
	const command = process.argv.includes("--daemon") ? runDaemon : runOnce;
	command().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
