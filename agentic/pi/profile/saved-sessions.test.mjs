import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { listSavedSessions } from "./saved-sessions.mjs";

function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const write = (directory, name, size = 0) => {
		fs.mkdirSync(directory, { recursive: true });
		const id = randomUUID(), file = path.join(directory, `${id}.jsonl`);
		const fd = fs.openSync(file, "w");
		try {
			fs.writeSync(fd, JSON.stringify({ type: "session", version: 3, id, cwd: root, timestamp: new Date().toISOString() }) + "\n");
			fs.writeSync(fd, JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Original task" }] } }) + "\n");
			if (size) fs.ftruncateSync(fd, size);
			fs.writeSync(fd, "\n" + JSON.stringify({ type: "session_info", name }) + "\n", size || null);
		} finally { fs.closeSync(fd); }
		return fs.realpathSync(file);
	};
	return { root, write };
}

test("multi-GB history discovery has a fixed read budget and no age cutoff", (t) => {
	const f = fixture(t);
	const file = f.write(path.join(f.root, "sessions", "project"), "Saved conversation", 4 * 1024 ** 3);
	fs.utimesSync(file, new Date("2020-01-01"), new Date("2020-01-01"));
	let bytes = 0;
	const read = fs.readSync;
	t.mock.method(fs, "readSync", (...args) => { const n = read(...args); bytes += n; return n; });
	const rows = listSavedSessions({ agentDir: f.root });
	assert.equal(rows.length, 1);
	assert.equal(rows[0].name, "Saved conversation");
	assert.equal(rows[0].firstMessage, "Original task");
	assert.equal(rows[0].path, file);
	assert(bytes <= 128 * 1024, `read ${bytes} bytes`);
});

test("discovery includes normal, custom and managed histories, deduplicating symlinks", (t) => {
	const f = fixture(t);
	const normal = f.write(path.join(f.root, "sessions", "project"), "Normal");
	const customDir = path.join(f.root, "custom");
	const custom = f.write(customDir, "Custom");
	fs.symlinkSync(customDir, path.join(f.root, "sessions", "alias"));
	const rows = listSavedSessions({ agentDir: f.root, sessionDir: customDir });
	assert.deepEqual(rows.map((s) => s.path).sort(), [normal, custom].sort());
	fs.writeFileSync(path.join(customDir, "partial.jsonl"), "{partial");
	assert.equal(listSavedSessions({ agentDir: f.root, sessionDir: customDir }).length, 2);
});

test("pilot scope cannot leak through symlinks and private profiles remain excluded", (t) => {
	const f = fixture(t);
	const scope = path.join(f.root, "pilot");
	const permitted = f.write(scope, "Permitted");
	const normalDir = path.join(f.root, "sessions", "project");
	f.write(normalDir, "Not in pilot");
	const privateDir = path.join(f.root, "profile-sessions", "librarian");
	f.write(privateDir, "Private");
	fs.symlinkSync(normalDir, path.join(scope, "escape"));
	fs.symlinkSync(privateDir, path.join(f.root, "sessions", "private-alias"));
	assert.deepEqual(listSavedSessions({ agentDir: f.root, scope }).map((s) => s.path), [permitted]);
	assert.equal(listSavedSessions({ agentDir: f.root, sessionDir: privateDir }).length, 1);
});
