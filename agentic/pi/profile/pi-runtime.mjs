/** Resolve the local runtime and verify the ownership adapter's required capabilities. */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
export function resolvePiPackage(env = process.env) {
	if (env.PI_CLI_PACKAGE) return path.resolve(env.PI_CLI_PACKAGE);
	const npm = path.join(path.dirname(process.execPath), "npm");
	const locate = (environment) =>
		path.join(
			execFileSync(fs.existsSync(npm) ? npm : "npm", ["root", "-g"], {
				encoding: "utf8",
				env: {
					...environment,
					PATH: `${path.dirname(process.execPath)}${path.delimiter}${environment.PATH ?? ""}`,
				},
			}).trim(),
			"@earendil-works",
			"pi-coding-agent",
		);
	const candidate = locate(env);
	if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
	// npm run --prefix exports its project prefix into children. It is not the
	// global installation prefix unless it actually contains the Pi package.
	const clean = Object.fromEntries(
		Object.entries(env).filter(([key]) => key.toLowerCase() !== "npm_config_prefix"),
	);
	return locate(clean);
}

/** Probe only disposable history before any real session is selected or reserved. */
export async function ownershipRuntime(pkg) {
	const version = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).version;
	let temporary;
	try {
		const { parseArgs } = await import(pathToFileURL(path.join(pkg, "dist/cli/args.js")).href);
		const api = await import(pathToFileURL(path.join(pkg, "dist/core/session-manager.js")).href);
		const { SessionManager, findMostRecentSession, CURRENT_SESSION_VERSION } = api;
		for (const method of ["parseSessionEntries", "buildSessionProjection"])
			if (typeof api[method] !== "function") throw new Error(`Native history ${method} missing`);
		if (typeof parseArgs !== "function" || typeof findMostRecentSession !== "function" || CURRENT_SESSION_VERSION !== 3)
			throw new Error("native selectors and session format 3 required");
		for (const method of ["findById", "list", "listAll"])
			if (typeof SessionManager?.[method] !== "function") throw new Error(`SessionManager.${method} missing`);
		for (const method of ["getSessionFile", "getSessionDir", "getSessionId", "getEntries", "getLeafId", "getSessionName"])
			if (typeof SessionManager.prototype[method] !== "function") throw new Error(`SessionManager.${method} missing`);
		for (const [flag, field] of [["--session", "session"], ["--fork", "fork"], ["--session-id", "sessionId"], ["--session-dir", "sessionDir"]]) {
			if (parseArgs([flag, "probe"])[field] !== "probe") throw new Error(`${flag} selector changed`);
		}
		for (const [flag, field] of [["--continue", "continue"], ["-c", "continue"], ["--resume", "resume"], ["-r", "resume"], ["--no-session", "noSession"], ["--no-extensions", "noExtensions"], ["-p", "print"]]) {
			if (parseArgs([flag])[field] !== true) throw new Error(`${flag} selector changed`);
		}
		const literal = parseArgs(["--", "--continue"]);
		if (literal.continue || !literal.messages?.includes("--continue")) throw new Error("argument terminator changed");
		const extension = parseArgs(["--extension", "probe"]);
		if (!extension.extensions?.includes("probe")) throw new Error("extension selector changed");
		temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-proof-"));
		const id = randomUUID(), file = path.join(temporary, `probe_${id}.jsonl`);
		const content = JSON.stringify({ type: "session", version: 3, id, cwd: temporary, timestamp: new Date().toISOString() }) + "\n";
		fs.writeFileSync(file, content, { mode: 0o600 });
		if (SessionManager.findById(temporary, id, temporary) !== file || findMostRecentSession(temporary, temporary) !== file || fs.readFileSync(file, "utf8") !== content)
			throw new Error("read-only native session lookup changed");
		return { parseArgs, SessionManager, findMostRecentSession };
	} catch (error) {
		throw new Error(`Pi ${version} lacks required ownership capabilities: ${error.message}`, { cause: error });
	} finally {
		if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
	}
}
