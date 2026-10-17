/** Process-local incognito state, retained across /reload but not shared with children. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type ReadonlySessionManager = ExtensionContext["sessionManager"];
const MODE = "PI_INCOGNITO_MODE";
const SESSION = "PI_INCOGNITO_SESSION_ID";
const SAVED_DIR = "PI_INCOGNITO_SAVED_DIR";

export function isIncognito(session: ReadonlySessionManager): boolean {
	return process.env.PI_SUBAGENT_CHILD !== "1" && process.env[MODE] === "1" &&
		process.env[SESSION] === session.getSessionId() && session.getSessionFile() === undefined;
}

export function incognitoRequested(): boolean {
	return process.env.PI_SUBAGENT_CHILD !== "1" && process.env[MODE] === "1";
}

export function savedSessionDir(): string | undefined {
	return process.env[SAVED_DIR] || undefined;
}

export function setIncognito(enabled: boolean, sessionDir?: string): void {
	if (enabled) {
		process.env[MODE] = "1";
		if (sessionDir) process.env[SAVED_DIR] = sessionDir;
	} else {
		delete process.env[MODE];
		delete process.env[SESSION];
		delete process.env[SAVED_DIR];
	}
}

export function syncIncognito(reason: string, session: ReadonlySessionManager): void {
	if (reason === "resume" || (reason === "startup" && session.getSessionFile() !== undefined)) {
		setIncognito(false);
	} else if (incognitoRequested() && (reason === "new" || reason === "fork") && session.getSessionFile() === undefined) {
		process.env[SESSION] = session.getSessionId();
	}
}
