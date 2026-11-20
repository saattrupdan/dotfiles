/** Guest provider adapter. Model inference crosses a file mailbox, never a socket. */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { inferenceRequest, MAX_RESPONSE_BYTES, publishJson, readRegularFile, sleep } from "./protocol.mjs";
import { unpackEvent } from "./events.mjs";

export function failureMessage(model, message, aborted = false) {
	return {
		role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: aborted ? "aborted" : "error", errorMessage: message, timestamp: Date.now(),
	};
}

export function mailboxStream(createStream, directory, model, context, options = {}) {
	const stream = createStream();
	void (async () => {
		const id = randomUUID();
		let terminal = false;
		try {
			let request = { context, options: Object.fromEntries(["reasoning", "maxTokens", "temperature", "cacheRetention"].filter((key) => options[key] !== undefined).map((key) => [key, options[key]])) };
			request = await options.onPayload?.(request, model) ?? request;
			inferenceRequest(request);
			publishJson(directory, `${id}.request`, request);
			let offset = 0, pending = "", responded = false;
			const decoder = new TextDecoder();
			const state = {};
			const deadline = Date.now() + 16 * 60_000;
			while (Date.now() < deadline) {
				if (options.signal?.aborted) throw new Error("Sandbox inference cancelled");
				let fd;
				try {
					fd = fs.openSync(path.join(directory, `${id}.events`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
					const stat = fs.fstatSync(fd);
					if (!stat.isFile() || stat.size > MAX_RESPONSE_BYTES || stat.size < offset) throw new Error("Invalid sandbox inference response");
					if (!responded) {
						await options.onResponse?.({ status: 200, headers: {} }, model);
						responded = true;
					}
					const buffer = Buffer.alloc(Math.min(stat.size - offset, 1024 * 1024));
					const size = fs.readSync(fd, buffer, 0, buffer.length, offset);
					offset += size;
					pending += decoder.decode(buffer.subarray(0, size), { stream: true });
				} catch (error) {
					if (error.code !== "ENOENT") throw error;
				} finally { if (fd !== undefined) fs.closeSync(fd); }
				let newline;
				while ((newline = pending.indexOf("\n")) !== -1) {
					const value = JSON.parse(pending.slice(0, newline));
					pending = pending.slice(newline + 1);
					if (value.error) throw new Error(value.error);
					if (value.event) {
						const event = unpackEvent(value.event, state);
						options.onProviderStreamEvent?.(event, model);
						stream.push(event);
						if (["done", "error"].includes(event.type)) terminal = true;
					}
					if (value.end) {
						if (!terminal) throw new Error("Sandbox inference ended without a result");
						stream.end();
						return;
					}
				}
				await sleep(25);
			}
			throw new Error("Sandbox inference broker timed out");
		} catch (error) {
			if (!terminal) {
				const message = failureMessage(model, error.message, options.signal?.aborted);
				stream.push({ type: "error", reason: message.stopReason, error: message });
				stream.end(message);
			}
		} finally {
			if (!terminal) { try { publishJson(directory, `${id}.cancel`, {}); } catch {} }
			for (const suffix of ["events", "request"]) {
				try { fs.unlinkSync(path.join(directory, `${id}.${suffix}`)); } catch {}
			}
		}
	})();
	return stream;
}

export async function installGuestProvider(pi) {
	if (process.platform !== "linux" || !fs.existsSync("/run/pi-sandbox")) throw new Error("The sandbox profile must run inside its Apple Container");
	const directory = process.env.PI_SANDBOX_MAILBOX;
	if (!directory) throw new Error("Missing sandbox inference mailbox");
	const model = JSON.parse(readRegularFile(path.join(directory, "model.json"), 65536));
	const pkg = process.env.PI_PACKAGE_DIR;
	const { createAssistantMessageEventStream } = await import(pathToFileURL(path.join(pkg, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
	pi.registerProvider(model.provider, {
		name: "Sandbox inference", api: "sandbox-inference", baseUrl: "sandbox://model", apiKey: "host-broker",
		models: [model],
		streamSimple: (selected, context, options) => mailboxStream(createAssistantMessageEventStream, directory, selected, context, options),
	});
	const show = (_event, ctx) => ctx.ui.setStatus("sandbox", "📦");
	pi.on("session_start", show);
	pi.on("agent_start", show);
	pi.registerCommand("sandbox", { description: "Open a fresh conversation inside this sandbox", handler: async (args, ctx) => {
		if (args.trim()) { ctx.ui.notify("Use /sandbox without arguments.", "error"); return; }
		await ctx.waitForIdle();
		await ctx.newSession();
	} });
}
