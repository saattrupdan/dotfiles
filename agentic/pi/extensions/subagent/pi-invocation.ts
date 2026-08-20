import * as fs from "node:fs";
import * as path from "node:path";

export interface PiRuntime {
	execPath: string;
	currentScript?: string;
	resolvedScript?: string;
}

export interface PiInvocation {
	command: string;
	args: string[];
}

function isCodingAgentCli(resolvedScript: string | undefined): boolean {
	if (!resolvedScript) return false;
	const normalized = resolvedScript.replaceAll("\\", "/");
	return normalized.endsWith("/@earendil-works/pi-coding-agent/dist/cli.js");
}

export function selectPiInvocation(args: string[], runtime: PiRuntime): PiInvocation {
	const { currentScript, execPath, resolvedScript } = runtime;
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");

	if (currentScript && !isBunVirtualScript && isCodingAgentCli(resolvedScript)) {
		return { command: execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: execPath, args };

	return { command: "pi", args };
}

export function getPiInvocation(args: string[]): PiInvocation {
	const currentScript = process.argv[1];
	let resolvedScript: string | undefined;

	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && fs.existsSync(currentScript)) {
		try {
			resolvedScript = fs.realpathSync(currentScript);
		} catch {
			// Fall back to the `pi` command when the host script cannot be resolved.
		}
	}

	return selectPiInvocation(args, {
		execPath: process.execPath,
		currentScript,
		resolvedScript,
	});
}
