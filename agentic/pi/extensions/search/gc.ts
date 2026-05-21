/**
 * Garbage collection for stale search indices.
 *
 * Runs once per pi process at extension init.
 *
 * Scans `~/.pi/index/*/meta.json`. For each entry:
 * - If `root` directory no longer exists → remove the entire index directory.
 * - If `last_used` is >30 days ago → same removal.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Run garbage collection. Called once at extension init.
 */
export function gc(): void {
	const home = os.homedir();
	const indexDir = path.join(home, ".pi", "index");

	if (!fs.existsSync(indexDir)) return;

	const entries = fs.readdirSync(indexDir);
	const now = Date.now();
	const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

	for (const entry of entries) {
		const repoId = entry;
		const dirPath = path.join(indexDir, repoId);

		if (!fs.statSync(dirPath).isDirectory()) continue;

		const metaPath = path.join(dirPath, "meta.json");
		if (!fs.existsSync(metaPath)) {
			// No meta → nothing to track, remove the whole thing
			fs.rmSync(dirPath, { recursive: true, force: true });
			continue;
		}

		try {
			const metaRaw = fs.readFileSync(metaPath, "utf-8");
			const meta = JSON.parse(metaRaw);

			// Check if root directory still exists
			if (meta.root && !fs.existsSync(meta.root)) {
				fs.rmSync(dirPath, { recursive: true, force: true });
				continue;
			}

			// Check if last_used is >30 days ago
			if (meta.last_used && now - meta.last_used > thirtyDaysMs) {
				fs.rmSync(dirPath, { recursive: true, force: true });
				continue;
			}
		} catch {
			// Corrupt meta.json → remove entire index dir
			fs.rmSync(dirPath, { recursive: true, force: true });
		}
	}
}
