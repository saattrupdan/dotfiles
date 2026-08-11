import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readCache, restoreSnapshotFromCache, runOnce } from "./refresh.mjs";

const SNAPSHOT_FILE = path.join(os.homedir(), ".pi", "agent", "memory-snapshot.md");
const CACHE_FILE = path.join(os.homedir(), ".pi", "agent", "memory-snapshot.json");

function readSnapshot(): string | null {
	try {
		if (!fs.existsSync(SNAPSHOT_FILE)) return null;
		return fs.readFileSync(SNAPSHOT_FILE, "utf-8");
	} catch {
		// A concurrently removed or unreadable snapshot is not safe to inject.
		return null;
	}
}

function ensureSnapshotSync(): void {
	if (fs.existsSync(SNAPSHOT_FILE)) return;
	const cache = readCache(CACHE_FILE);
	if (cache) {
		try {
			restoreSnapshotFromCache({ cacheFile: CACHE_FILE, snapshotFile: SNAPSHOT_FILE }, cache);
		} catch {
			// Leave the cache untouched when atomic restoration cannot complete.
		}
	}
}

export function appendSnapshotToSystemPrompt(systemPrompt: string, snapshot: string): string {
	return `${systemPrompt}\n\n${snapshot}`;
}

export function buildBeforeAgentStartResult(
	event: BeforeAgentStartEvent,
	snapshot: string | null,
): BeforeAgentStartEventResult | undefined {
	if (!snapshot) return undefined;
	return { systemPrompt: appendSnapshotToSystemPrompt(event.systemPrompt, snapshot) };
}

export default function api(pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		ensureSnapshotSync();
		await runOnce();
	});

	pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
		return buildBeforeAgentStartResult(event, readSnapshot());
	});
}
