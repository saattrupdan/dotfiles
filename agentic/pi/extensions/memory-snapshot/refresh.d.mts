export interface Cache {
	snapshot: string;
	updatedAt: number;
}

export const MAX_RESPONSE_BYTES: number;
export const UNDERSTORY_URL: string;
export function readCache(cacheFile: string): Cache | null;
export function restoreSnapshotFromCache(
	paths: { cacheFile: string; snapshotFile: string },
	cache: Cache | null,
): boolean;
export function runOnce(options?: { paths?: { cacheFile: string; snapshotFile: string }; now?: number; testFetchImpl?: (...args: unknown[]) => Promise<unknown> }): Promise<{ refreshed: boolean; cache: Cache | null; error?: unknown }>;
