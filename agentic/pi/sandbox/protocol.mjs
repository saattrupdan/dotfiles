/** Filesystem-only inference transport; no host commands or arbitrary URLs. */
import * as fs from "node:fs";
import * as path from "node:path";

export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
export const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function readRegularFile(file, maxBytes = MAX_REQUEST_BYTES) {
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > maxBytes) throw new Error("Invalid sandbox message file");
		const buffer = Buffer.alloc(stat.size + 1);
		const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
		if (size > maxBytes || size > stat.size) throw new Error("Sandbox message changed while reading");
		return buffer.subarray(0, size).toString("utf8");
	} finally { fs.closeSync(fd); }
}

export function publishJson(directory, name, value) {
	if (path.basename(name) !== name) throw new Error("Invalid sandbox message name");
	const temporary = path.join(directory, `.${name}.${crypto.randomUUID()}`);
	fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
	fs.renameSync(temporary, path.join(directory, name));
}

export function inferenceRequest(value) {
	if (!value || typeof value !== "object" || Array.isArray(value) ||
		Object.keys(value).some((key) => !["context", "options"].includes(key)) ||
		!value.context || typeof value.context !== "object" || Array.isArray(value.context) ||
		Object.keys(value.context).some((key) => !["messages", "systemPrompt", "tools"].includes(key)) ||
		!Array.isArray(value.context.messages) || value.context.messages.length > 10000) {
		throw new Error("Invalid sandbox inference request");
	}
	const options = value.options ?? {};
	if (!options || typeof options !== "object" || Array.isArray(options) ||
		Object.keys(options).some((key) => !["reasoning", "maxTokens", "temperature", "cacheRetention"].includes(key))) {
		throw new Error("Unsupported sandbox inference options");
	}
	if (options.reasoning !== undefined && !["minimal", "low", "medium", "high", "xhigh"].includes(options.reasoning))
		throw new Error("Invalid sandbox reasoning level");
	if (options.maxTokens !== undefined && (!Number.isInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > 262144))
		throw new Error("Invalid sandbox token limit");
	if (options.temperature !== undefined && (typeof options.temperature !== "number" || !Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2))
		throw new Error("Invalid sandbox temperature");
	if (options.cacheRetention !== undefined && !["none", "short", "long"].includes(options.cacheRetention))
		throw new Error("Invalid sandbox cache retention");
	return { context: value.context, options };
}
