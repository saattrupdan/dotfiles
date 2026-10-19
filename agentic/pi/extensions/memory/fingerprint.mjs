/** Cheap, deterministic input fingerprints for the hourly librarian. */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { list, readJob } from "../memory-handoff/queue.mjs";

function digest(entries) {
	const hash = createHash("sha256");
	for (const [name, bytes] of entries) {
		hash.update(name);
		hash.update("\0");
		hash.update(bytes);
		hash.update("\0");
	}
	return hash.digest("hex");
}

/** Hash active concepts and the canonical vector snapshot, not cleaner-generated logs or archives. */
export function fingerprintBundle(root) {
	const files = [];
	const walk = (folder) => {
		for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || (folder === root && ["requests", "embeddings"].includes(entry.name))) continue;
			const file = path.join(folder, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`Symlink in active memory bundle: ${file}`);
			if (entry.isDirectory()) walk(file);
			else if (entry.isFile() && entry.name.endsWith(".md") && !["index.md", "log.md"].includes(entry.name)) {
				files.push(file);
			}
		}
	};
	walk(root);
	const vector = path.join(root, "embeddings.sqlite");
	const info = fs.lstatSync(vector, { throwIfNoEntry: false });
	if (info && !info.isFile()) throw new Error("Embedding snapshot must be a regular file");
	if (info) files.push(vector);
	return digest(files.sort().map((file) => [path.relative(root, file), fs.readFileSync(file)]));
}

/** Stable failed-job inputs only: exclude review timestamps and other cleaner-generated bookkeeping. */
export function failedJobKey(job) {
	return digest([[job.id, JSON.stringify({ failedAt: job.failedAt, attempts: job.attempts ?? 0,
		unknownOutcome: job.unknownOutcome, retriedAt: job.retriedAt,
		textHash: createHash("sha256").update(job.text).digest("hex") })]]);
}

export function failedWorkSignature(root, now = Date.now()) {
	const entries = list(root, "failed").map((id) => readJob(root, "failed", id))
		.filter((job) => (job.attempts ?? 0) < 3 &&
			(!job.retriedAt || now - Date.parse(job.retriedAt) >= 60 * 60_000))
		.map((job) => [job.id, failedJobKey(job)]);
	return digest(entries);
}
