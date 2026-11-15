import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MIN_GAP_MS = 400;

type RunHoli = (args: string[], cwd: string) => Promise<string>;
export type NotificationSender = (title: string, body: string, sound: string) => void | Promise<void>;
export interface NotificationOrigin {
	cwd: string;
	conversationId: string;
}
export interface NotificationDelivery {
	ready: Promise<void>;
	send: NotificationSender;
}

interface DeliveryDeps {
	sendITerm: NotificationSender;
	runHoli?: RunHoli;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	rememberOrigin?: (origin: NotificationOrigin) => void;
}

async function runHoli(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("holi", args, {
		cwd,
		timeout: 2_000,
		maxBuffer: 256 * 1024,
		encoding: "utf8",
	});
	return stdout;
}

/** Keep the originating vault and Holi session even when Pi changes conversations
 *  or moves into a worktree. Only a matching live Pi session selects Holi. */
export function createNotificationDelivery(
	origin: NotificationOrigin,
	{ sendITerm, runHoli: run = runHoli, env = process.env, now = Date.now, rememberOrigin }: DeliveryDeps,
): NotificationDelivery {
	let holiSession: string | undefined;
	let linkSession = true;
	let discovery: Promise<void> | undefined;
	let lastNotifyAt = -Infinity;

	const discover = async () => {
		try {
			const sessions: unknown = JSON.parse(await run(["agent", "sessions", "--json"], origin.cwd));
			if (!Array.isArray(sessions)) return;
			const matches = sessions.filter((session) =>
				session?.provider === "pi" && session.conversationId === origin.conversationId &&
				typeof session.id === "string" && /^p[0-9a-f]{12}$/.test(session.id) && !session.closed,
			);
			if (matches.length === 1) {
				holiSession = matches[0].id;
				rememberOrigin?.(origin);
			}
		} catch {
			// Missing CLI, closed vault, and unavailable bridge leave iTerm routing unchanged.
		}
	};

	const probe = () => {
		discovery ??= discover().finally(() => { discovery = undefined; });
		return discovery;
	};
	// Verify and persist before a conversation switch or worktree relaunch can happen.
	const ready = probe();
	const send: NotificationSender = async (title, body, sound) => {
		if (!holiSession) await probe();
		if (!holiSession && (env.TERM_PROGRAM !== "iTerm.app" || !env.ITERM_SESSION_ID)) return;
		const at = now();
		if (at - lastNotifyAt < MIN_GAP_MS) return;
		lastNotifyAt = at;
		if (holiSession) {
			// Named arguments keep model-generated leading dashes out of CLI option parsing.
			const args = ["agent", "notify", `--title=${title.slice(0, 120)}`, `--line=${body.slice(0, 400)}`];
			try {
				await run(linkSession ? [...args, "--session", holiSession] : args, origin.cwd);
			} catch (error) {
				// Older Holi builds validate --session as a Claude job id, rejecting their own Pi ids.
				// That explicit validation failure wrote nothing; retry without a click target.
				const stderr = (error as { stderr?: unknown } | null)?.stderr;
				if (linkSession && typeof stderr === "string" &&
					stderr.includes(`BAD_REQUEST: not a session id: ${holiSession}`)) {
					linkSession = false;
					try { await run(args, origin.cwd); } catch { /* Holi delivery must not fail Pi. */ }
				}
				// Never redirect a lost Holi bridge's alerts into an inherited iTerm pane.
			}
			return;
		}
		await sendITerm(title, body, sound);
	};
	return { ready, send };
}
