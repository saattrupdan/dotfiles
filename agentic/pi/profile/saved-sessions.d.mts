export interface SavedSession {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	firstMessage: string;
	modified: Date;
}
export function listSavedSessions(options?: {
	agentDir?: string;
	sessionDir?: string;
	scope?: string;
}): SavedSession[];
