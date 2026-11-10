/** Discover saved conversations with bounded metadata reads, never full transcripts. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";

const WINDOW_BYTES = 64 * 1024;

function within(file, root) {
	const relative = path.relative(root, file);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function metadata(file) {
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const stats = fs.fstatSync(fd);
		if (!stats.isFile()) return;
		const head = Buffer.alloc(Math.min(WINDOW_BYTES, stats.size));
		const length = fs.readSync(fd, head, 0, head.length, 0);
		const text = head.subarray(0, length).toString("utf8");
		const header = JSON.parse(text.split("\n", 1)[0]);
		if (header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") return;
		let name, firstMessage = "";
		const windows = [text];
		if (stats.size > WINDOW_BYTES) {
			const tail = Buffer.alloc(WINDOW_BYTES);
			const read = fs.readSync(fd, tail, 0, tail.length, stats.size - tail.length);
			const text = tail.subarray(0, read).toString("utf8");
			windows.push(text.slice(text.indexOf("\n") + 1));
		}
		for (const window of windows) {
			for (const line of window.split("\n")) {
				try {
					const entry = JSON.parse(line);
					if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name.trim() || undefined;
					if (!firstMessage && entry.type === "message" && entry.message?.role === "user") {
						const content = entry.message.content;
						firstMessage = (typeof content === "string" ? content : Array.isArray(content) ? content.filter((part) => part.type === "text").map((part) => part.text).join(" ") : "").slice(0, 200);
					}
				} catch { /* A window edge or concurrent append can contain a partial entry. */ }
			}
		}
		return { path: file, id: header.id, cwd: header.cwd, name, firstMessage, modified: stats.mtime };
	} finally { fs.closeSync(fd); }
}

/** Search the normal history plus an optional custom directory, or only the pilot scope. */
export function listSavedSessions({ agentDir = path.join(os.homedir(), ".pi", "agent"), sessionDir, scope } = {}) {
	const files = new Set(), directories = new Set(), rows = [];
	const privatePath = path.resolve(agentDir, "profile-sessions");
	const privateRoot = fs.existsSync(privatePath) ? fs.realpathSync(privatePath) : path.join(fs.existsSync(agentDir) ? fs.realpathSync(agentDir) : path.resolve(agentDir), "profile-sessions");
	const allowedRoot = scope ? fs.realpathSync(scope) : undefined;
	const allowed = (file) => !within(file, privateRoot) && (!allowedRoot || within(file, allowedRoot));
	const scan = (directory) => {
		try {
			const canonical = fs.realpathSync(directory);
			if (directories.has(canonical) || !allowed(canonical)) return;
			directories.add(canonical);
			for (const entry of fs.readdirSync(canonical)) {
				if (!entry.endsWith(".jsonl")) continue;
				try {
					const file = fs.realpathSync(path.join(canonical, entry));
					if (allowed(file)) files.add(file);
				} catch { /* Concurrent removal. */ }
			}
		} catch { /* Missing or unreadable histories do not hide other roots. */ }
	};
	for (const root of scope ? [scope] : [path.join(agentDir, "sessions"), sessionDir].filter(Boolean)) {
		scan(root);
		try {
			for (const entry of fs.readdirSync(root, { withFileTypes: true }))
				if (entry.isDirectory() || entry.isSymbolicLink()) scan(path.join(root, entry.name));
		} catch { /* The directory may not exist yet. */ }
	}
	for (const file of files) {
		try { const row = metadata(file); if (row) rows.push(row); }
		catch { /* Invalid or disappearing histories stay out of the picker. */ }
	}
	return rows.sort((a, b) => +b.modified - +a.modified);
}
