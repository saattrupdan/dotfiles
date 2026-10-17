/** /incognito switches between fresh in-memory and saved sessions. */
import path from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isIncognito, savedSessionDir, setIncognito, syncIncognito } from "../_incognito_state/state.js";

const STATUS_KEY = "incognito";
const WRITE_TOOLS = new Set(["memory_add", "memory_update"]);

function showStatus(ctx: { ui: { setStatus(key: string, text: string | undefined): void }; sessionManager: Parameters<typeof isIncognito>[0] }): void {
	ctx.ui.setStatus(STATUS_KEY, isIncognito(ctx.sessionManager) ? "👻" : undefined);
}

// Pi's command API can replace sessions, but cannot select persistence for the
// replacement. The setup callback receives the real SessionManager, before any
// user message is appended. These are its runtime fields (not the read-only ctx
// facade); check their shape so an upstream change cannot silently save a turn.
function setPersistence(manager: SessionManager, enabled: boolean, sessionDir?: string): void {
	const internal = manager as unknown as { persist?: unknown; sessionFile?: unknown; sessionDir?: unknown };
	if (typeof internal.persist !== "boolean" || typeof internal.sessionDir !== "string" ||
		(internal.sessionFile !== undefined && typeof internal.sessionFile !== "string")) {
		throw new Error("Pi's session persistence internals changed; incognito cannot safely switch sessions.");
	}
	if (manager.getEntries().some((entry) => entry.type === "message")) {
		throw new Error("Cannot change persistence after a message was added.");
	}
	if (enabled) {
		const header = manager.getHeader();
		if (!header || header.id !== manager.getSessionId()) throw new Error("Invalid new session header.");
		// Do not call manager.newSession() here: Pi has already constructed the
		// agent with this ID, so replacing it would desynchronize the runtime.
		const directory = SessionManager.create(manager.getCwd(), sessionDir).getSessionDir();
		internal.sessionDir = directory;
		internal.sessionFile = path.join(directory, `${header.timestamp.replace(/[:.]/g, "-")}_${header.id}.jsonl`);
		internal.persist = true;
	} else {
		internal.persist = false;
		internal.sessionFile = undefined;
	}
	if (manager.isPersisted() !== enabled || (manager.getSessionFile() === undefined) !== !enabled) {
		throw new Error("Could not switch session persistence.");
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("incognito", {
		description: "Start an unsaved session, send a private prompt, or use 'off' to return to saved sessions.",
		async handler(args, ctx) {
			const prompt = args.trim();
			const turningOff = prompt === "off";
			if (turningOff && !isIncognito(ctx.sessionManager)) {
				ctx.ui.notify("Incognito is already off.", "info");
				return;
			}
			await ctx.waitForIdle();
			const wasActive = isIncognito(ctx.sessionManager);
			const sessionDir = wasActive ? savedSessionDir() : ctx.sessionManager.getSessionDir();
			// The new session is deliberately empty: never copy incognito history
			// into a persisted session or append private turns to an old file.
			setIncognito(!turningOff, sessionDir);
			try {
				const result = await ctx.newSession({
					setup: async (manager) => { setPersistence(manager, turningOff, sessionDir); },
					withSession: async (next) => {
						syncIncognito("new", next.sessionManager);
						showStatus(next);
						next.ui.notify(turningOff ? "Incognito off. Started a new saved session." : "Incognito on. This session is not saved.", "info");
						if (!turningOff && prompt) await next.sendUserMessage(prompt);
					},
				});
				if (result.cancelled) setIncognito(wasActive, sessionDir);
			} catch (error) {
				setIncognito(wasActive, sessionDir);
				throw error;
			}
		},
	});

	pi.on("session_start", (event, ctx) => {
		syncIncognito(event.reason, ctx.sessionManager);
		showStatus(ctx);
	});
	pi.on("agent_start", (_event, ctx) => {
		if (isIncognito(ctx.sessionManager)) {
			pi.setActiveTools(pi.getActiveTools().filter((name) => !WRITE_TOOLS.has(name)));
		}
		showStatus(ctx);
	});
	pi.on("tool_call", (event, ctx) => {
		if (isIncognito(ctx.sessionManager) && WRITE_TOOLS.has(event.toolName)) {
			return { block: true, reason: `${event.toolName} is disabled in incognito mode.` };
		}
	});
}
