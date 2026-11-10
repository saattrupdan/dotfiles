export function resolvePiPackage(env?: NodeJS.ProcessEnv): string;
export function ownershipRuntime(pkg: string): Promise<{
	parseArgs: typeof import("@earendil-works/pi-coding-agent").parseArgs;
	SessionManager: typeof import("@earendil-works/pi-coding-agent").SessionManager;
	findMostRecentSession: (sessionDir: string, cwd?: string) => string | null;
}>;
