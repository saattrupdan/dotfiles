/** Authenticated supervisor request; /sandbox always creates a fresh conversation. */
import { randomUUID } from "node:crypto";

export function requestSandbox(state, transport = process, timeout = 15000) {
	if (!transport.send || !transport.connected || !transport.env.PI_PROFILE_RELOAD_TOKEN) return Promise.reject(new Error("This Pi session has no launcher supervisor. Reload Pi through its usual app entry point first."));
	const token = transport.env.PI_PROFILE_RELOAD_TOKEN, id = randomUUID();
	return new Promise((resolve, reject) => {
		const finish = (error, value) => {
			clearTimeout(timer);
			transport.off("message", receive); transport.off("disconnect", disconnected);
			error ? reject(error) : resolve(value);
		};
		const receive = (message) => {
			if (message?.type === "pi-sandbox-result" && message.token === token && message.id === id) finish(undefined, message);
		};
		const disconnected = () => finish(new Error("Sandbox launcher disconnected"));
		const timer = setTimeout(() => {
			try { transport.send({ type: "pi-sandbox-cancel", token, id }, () => {}); } catch {}
			finish(new Error("Sandbox launcher timed out"));
		}, timeout);
		transport.on("message", receive); transport.on("disconnect", disconnected);
		try { transport.send({ type: "pi-sandbox-request", token, id, state }, (error) => { if (error) finish(error); }); }
		catch (error) { finish(error); }
	});
}
