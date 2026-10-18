export interface Cache { snapshot: string; updatedAt: number }
export interface SnapshotPaths { cacheFile: string; snapshotFile: string }
export const DEFAULT_ROOT: string;
export const DEFAULT_PATHS: SnapshotPaths;
export function readCache(file: string): Cache | null;
export function restoreSnapshotFromCache(paths: SnapshotPaths, cache: Cache | null): boolean;
export function refreshCache(options?: { root?: string; paths?: SnapshotPaths; now?: number }): Promise<{
	refreshed: boolean; cache: Cache | null; error?: Error;
}>;
