/**
 * `code_tree` tool.
 *
 * Shows a directory tree of the repo (or a subdirectory). Token-efficient by
 * default: prints directories only, depth-limited, with the recursive file
 * count per directory. The agent probes deeper by passing `path` and/or
 * `depth` explicitly.
 *
 * Source of truth for the file list is `git ls-files` so .gitignore is honored
 * with no extra config. Falls back to a filesystem walk outside a git repo.
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 6;
const MAX_LINES = 200;

const Params = Type.Object({
	path: Type.Optional(
		Type.String({
			description:
				"Subdirectory to show (relative to cwd or absolute). Default: cwd.",
		}),
	),
	depth: Type.Optional(
		Type.Integer({
			description: `How many levels below the starting path to show (1-${MAX_DEPTH}). Default ${DEFAULT_DEPTH}.`,
			minimum: 1,
			maximum: MAX_DEPTH,
			default: DEFAULT_DEPTH,
		}),
	),
	include_files: Type.Optional(
		Type.Boolean({
			description:
				"If false, show directories only with recursive file counts. Default true (include files at each level).",
			default: true,
		}),
	),
});

interface DirNode {
	name: string;
	dirs: Map<string, DirNode>;
	files: string[];
	fileCountRecursive: number;
}

function emptyDir(name: string): DirNode {
	return { name, dirs: new Map(), files: [], fileCountRecursive: 0 };
}

function repoRoot(cwd: string): string | null {
	try {
		const out = childProcess
			.execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
			.trim();
		return out || null;
	} catch {
		return null;
	}
}

function listGitFiles(root: string): string[] | null {
	try {
		const out = childProcess.execFileSync(
			"git",
			["ls-files", "--cached", "--others", "--exclude-standard"],
			{ cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
		);
		return out.split("\n").filter(Boolean);
	} catch {
		return null;
	}
}

const FS_SKIP = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	".turbo",
	".cache",
	"target",
	"venv",
	".venv",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
]);

function listFsFiles(root: string): string[] {
	const files: string[] = [];
	const walk = (dir: string, rel: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name.startsWith(".") && e.name !== ".github") continue;
			if (FS_SKIP.has(e.name)) continue;
			const sub = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) walk(path.join(dir, e.name), sub);
			else if (e.isFile()) files.push(sub);
		}
	};
	walk(root, "");
	return files;
}

function buildTree(files: string[]): DirNode {
	const root = emptyDir("");
	for (const file of files) {
		const parts = file.split("/");
		let node = root;
		for (let i = 0; i < parts.length - 1; i++) {
			const name = parts[i];
			let child = node.dirs.get(name);
			if (!child) {
				child = emptyDir(name);
				node.dirs.set(name, child);
			}
			node = child;
		}
		node.files.push(parts[parts.length - 1]);
	}
	const countFiles = (n: DirNode): number => {
		let c = n.files.length;
		for (const d of n.dirs.values()) c += countFiles(d);
		n.fileCountRecursive = c;
		return c;
	};
	countFiles(root);
	return root;
}

function renderTree(node: DirNode, depth: number, includeFiles: boolean): string[] {
	const lines: string[] = [];
	const render = (n: DirNode, prefix: string, level: number) => {
		const dirNames = Array.from(n.dirs.keys()).sort();
		for (const name of dirNames) {
			const child = n.dirs.get(name)!;
			lines.push(`${prefix}${name}/  (${child.fileCountRecursive})`);
			if (level + 1 < depth) render(child, `${prefix}  `, level + 1);
		}
		if (includeFiles && level < depth) {
			for (const f of n.files.sort()) lines.push(`${prefix}${f}`);
		}
		if (lines.length > MAX_LINES) return;
	};
	render(node, "", 0);
	return lines;
}

function resolveSubtree(root: DirNode, relPath: string): DirNode | null {
	if (!relPath || relPath === "." || relPath === "./") return root;
	const parts = relPath.replace(/^\/+/, "").split("/").filter(Boolean);
	let node = root;
	for (const p of parts) {
		const next = node.dirs.get(p);
		if (!next) return null;
		node = next;
	}
	return node;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "code_tree",
		label: "code tree",
		description:
			"Show a minimal directory tree of the repo (.gitignore-honoring). " +
			"By default prints directories only, with a recursive file count per dir, " +
			`${DEFAULT_DEPTH} levels deep from the repo root. ` +
			"Use `path` to drill into a subdirectory, `depth` to go further, `include_files=true` to list files at the deepest shown level. " +
			"Keep it small: probe one subtree at a time rather than dumping the whole repo.",
		parameters: Params,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			const root = repoRoot(cwd) ?? cwd;
			const files = listGitFiles(root) ?? listFsFiles(root);
			const tree = buildTree(files);

			const requested = params.path ?? "";
			const abs = requested ? path.resolve(cwd, requested) : root;
			const relToRoot = path.relative(root, abs);
			const subtree = resolveSubtree(tree, relToRoot);
			if (!subtree) {
				return {
					content: [
						{ type: "text", text: `No such path in tree: ${requested || "."} (relative to repo root ${root})` },
					],
					isError: true,
					details: undefined,
				};
			}

			const depth = params.depth ?? DEFAULT_DEPTH;
			const lines = renderTree(subtree, depth, params.include_files ?? true);
			const truncated = lines.length > MAX_LINES;
			const view = truncated ? lines.slice(0, MAX_LINES) : lines;
			const header = `# tree ${relToRoot || "."} (${subtree.fileCountRecursive} files, depth ${depth})`;
			const footer = truncated
				? `# ... truncated at ${MAX_LINES} lines — narrow with \`path\` or reduce \`depth\``
				: "# pass `path=<subdir>` to drill down, `include_files=true` to list files";
			return {
				content: [{ type: "text", text: `${header}\n${view.join("\n")}\n${footer}` }],
				details: undefined,
			};
		},

		renderCall(args, theme) {
			const p = (args?.path as string | undefined) ?? ".";
			const d = (args?.depth as number | undefined) ?? DEFAULT_DEPTH;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("code_tree "))}${theme.fg("accent", p)}${theme.fg("warning", ` d=${d}`)}`,
				0,
				0,
			);
		},

		renderResult(result, options, theme) {
			// If collapsed (not expanded), show only a summary line
			if (!options.expanded) {
				const text = (result.content ?? [])
					.filter((c) => c.type === "text")
					.map((c) => c.text ?? "")
					.join("\n");
				// Extract summary from header line: "# tree <path> (<N> files, depth <d>)"
				const headerMatch = text.match(/^# tree (.+) \((\d+) files, depth (\d+)\)/);
				if (headerMatch) {
					const [, treePath, fileCount] = headerMatch;
					return new Text(
						theme.fg("muted", `code_tree `) +
						theme.fg("accent", treePath) +
						theme.fg("success", ` ✓ ${fileCount} files`),
						0,
						0,
					);
				}
				// Fallback for errors or unexpected output
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const details = result.details as any;
				if (details?.isError) {
					return new Text(theme.fg("error", "✗ code_tree failed"), 0, 0);
				}
				return new Text(theme.fg("success", "✓ code_tree executed"), 0, 0);
			}

			// Expanded: show full tree output
			const text = (result.content ?? [])
				.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("\n");
			return new Text(text || "(no output)", 0, 0);
		},
	});
}
