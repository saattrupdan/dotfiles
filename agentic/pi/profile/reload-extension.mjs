/** Native /reload hook; the launcher owns validation and process replacement. */
import { randomUUID } from "node:crypto";

export function requestProfileReload(state, transport = process, timeout = 10000) {
	const id = randomUUID(),
		token = transport.env?.PI_PROFILE_RELOAD_TOKEN;
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error, result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			transport.off("message", onMessage);
			transport.off("disconnect", onDisconnect);
			error ? reject(error) : resolve(result);
		};
		const onMessage = (message) => {
			if (
				message?.type === "pi-profile-reload-result" &&
				message.id === id &&
				message.token === token
			)
				finish(undefined, message);
		};
		const onDisconnect = () => finish(new Error("Profile reload supervisor disconnected"));
		const timer = setTimeout(() => {
			try {
				transport.send?.({ type: "pi-profile-reload-cancel", id, token }, () => {});
			} catch {}
			finish(new Error("Profile reload supervisor timed out"));
		}, timeout);
		transport.on("message", onMessage);
		transport.on("disconnect", onDisconnect);
		try {
			transport.send({ type: "pi-profile-reload-request", id, token, state }, (error) => {
				if (error) finish(error);
			});
		} catch (error) {
			finish(error);
		}
	});
}

export default function profileReloadExtension(pi) {
	if (!process.send || !process.connected || !process.env.PI_PROFILE_RELOAD_TOKEN) return;
	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason !== "reload") return;
		const entries = ctx.sessionManager.getEntries();
		const stringFlags = [
			...new Set(
				process.argv
					.slice(2)
					.filter((arg) => arg.startsWith("--"))
					.map((arg) => arg.split("=", 1)[0])
					.filter((flag) => typeof pi.getFlag(flag.slice(2)) === "string"),
			),
		];
		try {
			const result = await requestProfileReload({
				sessionFile: ctx.sessionManager.getSessionFile(),
				sessionId: ctx.sessionManager.getSessionId(),
				leafId: ctx.sessionManager.getLeafId(),
				tipId: entries.at(-1)?.id,
				empty: !entries.some((entry) => entry.type === "message" || entry.type === "compaction"),
				name: ctx.sessionManager.getSessionName(),
				cwd: ctx.cwd,
				mode: ctx.mode,
				model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
				thinking: pi.getThinkingLevel(),
				stringFlags,
			});
			if (result.status === "rejected") throw new Error(result.error);
			if (result.status !== "restart") return;
			ctx.ui.notify("Profile updated; resuming this conversation with the new resources.", "info");
			process.env.PI_PROFILE_RELOAD_REPLACING = "1";
			ctx.shutdown();
			// Do not let the outgoing native reload rebuild its obsolete resource list.
			// Graceful quit emits a separate shutdown event, which does not enter this path.
			await new Promise(() => {});
		} catch (error) {
			ctx.ui.notify(`Profile reload: ${error.message}`, "error");
		}
	});
}
