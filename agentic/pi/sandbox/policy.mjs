/** Repository opt-in and the deliberately small sandbox launch interface. */
import * as fs from "node:fs";
import * as path from "node:path";

export const SANDBOX_CONFIG = ".pi/sandbox.json";

export function repositorySandbox(cwd) {
	let root = fs.realpathSync(cwd);
	while (!fs.existsSync(path.join(root, ".git"))) {
		const parent = path.dirname(root);
		if (parent === root) return undefined;
		root = parent;
	}
	const config = path.join(root, SANDBOX_CONFIG);
	if (!fs.existsSync(config)) return undefined;
	const stat = fs.lstatSync(config);
	if (!stat.isFile() || stat.size > 4096) throw new Error(`${config}: expected a small regular JSON file`);
	const value = JSON.parse(fs.readFileSync(config, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value) ||
		Object.keys(value).some((key) => key !== "enabled") || typeof value.enabled !== "boolean") {
		throw new Error(`${config}: expected {"enabled":true} or {"enabled":false}`);
	}
	return value.enabled ? { root, config } : undefined;
}

/** Fresh guest sessions never resume host transcripts or accept arbitrary CLI resources. */
export function sandboxArguments(args) {
	const result = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") return [...result, ...args.slice(i)];
		if (!arg.startsWith("-")) { result.push(arg); continue; }
		const [flag, inline] = arg.split("=", 2);
		if (["-p", "--print", "--no-session"].includes(flag)) { result.push(arg); continue; }
		// Neovim supplies an editor-status extension to host sessions. It is not
		// loaded in the guest; the sandbox profile owns its extension allow-list.
		if (["--extension", "-e"].includes(flag)) {
			const value = inline ?? args[++i];
			if (!value || !value.replaceAll("\\", "/").endsWith("/pi-agent.nvim/lua/pi-agent/status.ts")) throw new Error("Host extensions cannot override the sandbox profile");
			continue;
		}
		if (flag === "--session-id") {
			const value = inline ?? args[++i];
			if (!value || !/^[a-zA-Z0-9_.-]{1,256}$/.test(value)) throw new Error("Invalid sandbox session identity");
			result.push(flag, value);
			continue;
		}
		if (["--mode", "--thinking", "--tui-mode"].includes(flag)) {
			const value = inline ?? args[++i];
			if (!value || (flag === "--mode" && !["text", "json", "rpc"].includes(value)) ||
				(flag === "--thinking" && !["off", "minimal", "low", "medium", "high", "xhigh"].includes(value)) ||
				(flag === "--tui-mode" && !["regular", "pilot"].includes(value))) {
				throw new Error(`Invalid sandbox ${flag}`);
			}
			result.push(flag, value);
			continue;
		}
		throw new Error(`${flag} cannot override a fresh sandbox session`);
	}
	return result;
}
