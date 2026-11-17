/** Return to the originating terminal session without inspecting its contents. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export type ReturnTarget = { kind: "iterm"; sessionID: string } | { kind: "application"; bundleID: string };
type FocusCommand = (file: string, args: string[]) => Promise<string>;

const ITERM_FOCUS = `
on run argv
	set targetID to item 1 of argv
	if application id "com.googlecode.iterm2" is not running then return "missing"
	tell application id "com.googlecode.iterm2"
		repeat with aWindow in windows
			repeat with aTab in tabs of aWindow
				repeat with aSession in sessions of aTab
					if id of aSession is targetID then
						activate
						select aTab
						select aSession
						select aWindow
						return "restored"
					end if
				end repeat
			end repeat
		end repeat
	end tell
	return "missing"
end run`.trim();

export function captureReturnTarget(env: NodeJS.ProcessEnv = process.env): ReturnTarget | undefined {
	if (env.TERM_PROGRAM === "iTerm.app" && env.ITERM_SESSION_ID) {
		const raw = env.ITERM_SESSION_ID;
		return { kind: "iterm", sessionID: raw.slice(raw.indexOf(":") + 1) };
	}
	const terminals: Record<string, string> = {
		"iTerm.app": "com.googlecode.iterm2",
		Apple_Terminal: "com.apple.Terminal",
		ghostty: "com.mitchellh.ghostty",
	};
	const bundleID = terminals[env.TERM_PROGRAM ?? ""] ?? env.__CFBundleIdentifier;
	if (bundleID && /^(?:[a-zA-Z0-9-]+\.)+[a-zA-Z0-9-]+$/.test(bundleID)) return { kind: "application", bundleID };
	return undefined;
}

async function runCommand(file: string, args: string[]): Promise<string> {
	const { stdout } = await exec(file, args, { timeout: 5_000 });
	return stdout;
}

export async function returnToPi(target: ReturnTarget | undefined, run: FocusCommand = runCommand): Promise<void> {
	if (!target) return;
	if (target.kind === "iterm") {
		const outcome = await run("/usr/bin/osascript", ["-e", ITERM_FOCUS, target.sessionID]);
		if (outcome.trim() !== "restored") throw new Error("The originating Pi session is no longer available.");
	} else {
		await run("/usr/bin/open", ["-b", target.bundleID]);
	}
}
