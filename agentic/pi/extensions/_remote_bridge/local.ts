/** Authenticated local-user coordination; no network listener in Pi. */
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
export const dataDirectory = () =>
	process.env.PI_REMOTE_DATA_DIR ||
	path.join(os.homedir(), "Library", "Application Support", "PiRemote");
export function localAction(action: string, data: Record<string, unknown> = {}): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const dir = dataDirectory();
		const socket = net.connect(path.join(dir, "broker.sock"));
		let buffer = "";
		const id = randomUUID();
		socket.setEncoding("utf8");
		socket.setTimeout(15000, () => {
			socket.destroy();
			reject(new Error("Pi Remote broker unavailable"));
		});
		socket.on("error", reject);
		socket.on("connect", () => {
			try {
				socket.write(
					JSON.stringify({ secret: fs.readFileSync(path.join(dir, "ipc.key"), "utf8").trim() }) +
						"\n",
				);
			} catch (e) {
				socket.destroy();
				reject(e);
			}
		});
		socket.on("data", (chunk) => {
			buffer += chunk;
			if (buffer.length > 1000000) {
				socket.destroy();
				reject(new Error("Invalid broker reply"));
				return;
			}
			let i: number;
			while ((i = buffer.indexOf("\n")) >= 0) {
				const msg = JSON.parse(buffer.slice(0, i));
				buffer = buffer.slice(i + 1);
				if (msg.type === "ready")
					socket.write(JSON.stringify({ type: "admin", id, action, data }) + "\n");
				if (msg.type === "reply" && msg.id === id) {
					socket.end();
					if (msg.error) reject(new Error(msg.error));
					else resolve(msg.data);
				}
			}
		});
	});
}
