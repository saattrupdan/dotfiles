/** Host-owned, fixed-model inference broker. Guest requests never run host tools. */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { inferenceRequest, MAX_RESPONSE_BYTES, publishJson, readRegularFile, REQUEST_ID, sleep } from "./protocol.mjs";
import { cleanMessage, packEvent } from "./events.mjs";
import { failureMessage } from "./guest-provider.mjs";

export function publicModel(model) {
	const { id, name, provider, reasoning, input, cost, contextWindow, maxTokens, thinkingLevelMap } = model;
	return { id, name, provider, reasoning, input, cost, contextWindow, maxTokens, thinkingLevelMap, api: "sandbox-inference", baseUrl: "sandbox://model" };
}

export async function createHostModel(pkg, agentDir, selected) {
	const { ModelRuntime } = await import(pathToFileURL(path.join(pkg, "dist/core/model-runtime.js")).href);
	const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
	const available = await runtime.getAvailable();
	const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
	const choice = selected ?? { provider: settings.defaultProvider, id: settings.defaultModel };
	const model = available.find((m) => m.provider === choice.provider && m.id === choice.id);
	if (!model) throw new Error("The selected model is not available to the sandbox inference broker. Select an authenticated model in Pi first.");
	return { model, runtime, stream: (context, options) => runtime.streamSimple(model, context, options) };
}

export function startBroker(directory, hostModel, { responseLimit = MAX_RESPONSE_BYTES } = {}) {
	let stopped = false;
	const active = new Map();
	const tasks = new Set();
	const seen = new Set();
	publishJson(directory, "model.json", publicModel(hostModel.model));

	const handle = async (id) => {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15 * 60_000);
		active.set(id, controller);
		let fd;
		try {
			fd = fs.openSync(path.join(directory, `${id}.events`), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
			let bytes = 0;
			const send = (value, terminal = false) => {
				const data = `${JSON.stringify(value)}\n`;
				const size = Buffer.byteLength(data);
				const limit = terminal ? responseLimit : responseLimit - Math.min(4096, Math.floor(responseLimit / 4));
				if (bytes + size > limit) throw new Error("Sandbox response size limit exceeded");
				fs.writeSync(fd, data);
				bytes += size;
			};
			try {
				const request = inferenceRequest(JSON.parse(readRegularFile(path.join(directory, `${id}.request`))));
				for await (const event of hostModel.stream(request.context, { ...request.options, signal: controller.signal })) {
					if (event.type === "error" || (event.type === "done" && (["error", "aborted"].includes(event.message.stopReason) || event.message.errorMessage))) {
						const error = failureMessage(hostModel.model, "Sandbox inference failed; check host model availability", event.reason === "aborted");
						send({ event: { type: "error", reason: error.stopReason, error } }, true);
						break;
					}
					const safe = event.type === "done" ? { ...event, message: cleanMessage(event.message) } : event;
					send({ event: packEvent(safe) });
				}
				send({ end: true }, true);
			} catch {
				// Stop provider generation before reporting a transport or provider failure.
				const cancelled = controller.signal.aborted;
				controller.abort();
				try { send({ error: cancelled ? "Sandbox inference cancelled or timed out" : "Sandbox inference failed; check host model availability" }, true); } catch {}
			}
		} catch {
			// A conflicting guest-created output is never followed, truncated, or reused.
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
			clearTimeout(timeout);
			active.delete(id);
			try { fs.unlinkSync(path.join(directory, `${id}.request`)); } catch {}
		}
	};

	const poll = async () => {
		while (!stopped) {
			for (const [id, controller] of active) {
				if (fs.existsSync(path.join(directory, `${id}.cancel`))) controller.abort();
			}
			let files;
			try { files = fs.readdirSync(directory); } catch { break; }
			for (const file of files) {
				if (stopped || active.size >= 4 || seen.size >= 10000) break;
				const id = file.endsWith(".request") ? file.slice(0, -8) : "";
				if (!REQUEST_ID.test(id) || seen.has(id)) continue;
				seen.add(id);
				const task = handle(id);
				tasks.add(task);
				void task.finally(() => tasks.delete(task));
			}
			await sleep(25);
		}
	};
	const finished = poll();
	return {
		async stop() {
			stopped = true;
			for (const controller of active.values()) controller.abort();
			await finished;
			await Promise.allSettled([...tasks]);
			await hostModel.runtime?.settleCredentialWrites();
		},
	};
}
