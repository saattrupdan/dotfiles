/** Resolve the locally installed Pi runtime. */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
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
