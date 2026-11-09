export const SUPPORTED_PI_VERSION = "1.5.0";
/** Broker-independent process locks; SQLite's OS locks serialize acquisition/reaping. */
import process from "node:process";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const OWNERSHIP_ENV = "PI_SESSION_OWNER";
export const ROOT_ENV = "PI_SESSION_LOCK_ROOT";
const BIRTH_PREFIX = "ps:C:";

export function processIdentity(pid = process.pid) {
	try {
		process.kill(pid, 0);
		const birth = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
			encoding: "utf8",
			env: { ...process.env, LC_ALL: "C" },
		}).trim();
		return birth ? BIRTH_PREFIX + birth : undefined;
	} catch {
		return undefined;
	}
}

export function lockRoot(env = process.env) {
	return (
		env[ROOT_ENV] ||
		path.join(os.homedir(), "Library", "Application Support", "PiRemote", "ownership")
	);
}

export function canonicalFile(file) {
	const absolute = path.resolve(file);
	if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
	const parent = path.dirname(absolute);
	return path.join(
		fs.existsSync(parent) ? fs.realpathSync(parent) : parent,
		path.basename(absolute),
	);
}

export function historyInScope(file, scope = process.env.PI_SESSION_HISTORY_SCOPE) {
	if (!scope) return true;
	try {
		const target = fs.lstatSync(file, { throwIfNoEntry: false })
			? fs.realpathSync(file)
			: path.join(fs.realpathSync(path.dirname(path.resolve(file))), path.basename(file));
		const relative = path.relative(fs.realpathSync(scope), target);
		return !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
	} catch {
		return false;
	}
}

export function newOwner(kind = "local", pid = process.pid) {
	const birth = processIdentity(pid);
	if (!birth) throw new Error("Cannot establish process identity");
	return { instanceId: randomUUID(), pid, birth, kind };
}

export function isAlive(owner) {
	if (!owner) return false;
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		return error.code !== "ESRCH";
	}
	const birth = processIdentity(owner.pid);
	return birth === undefined || birth === owner.birth || birth === BIRTH_PREFIX + owner.birth;
}

function transaction(root, fn) {
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	const db = new DatabaseSync(path.join(root, "locks.sqlite"));
	try {
		fs.chmodSync(path.join(root, "locks.sqlite"), 0o600);
		db.exec(
			"PRAGMA busy_timeout=10000; CREATE TABLE IF NOT EXISTS locks (key TEXT PRIMARY KEY, record TEXT NOT NULL)",
		);
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn(db);
			db.exec("COMMIT");
			return result;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	} finally {
		db.close();
	}
}

function read(db, key) {
	const row = db.prepare("SELECT record FROM locks WHERE key=?").get(key);
	if (!row) return undefined;
	try {
		return JSON.parse(row.record);
	} catch {
		throw new Error("Uncertain ownership record; refusing takeover");
	}
}

function write(db, key, record) {
	db.prepare(
		"INSERT INTO locks VALUES (?,?) ON CONFLICT(key) DO UPDATE SET record=excluded.record",
	).run(key, JSON.stringify(record));
}

function sessionId(file) {
	if (!fs.existsSync(file) || fs.statSync(file).size === 0) return undefined;
	const fd = fs.openSync(file, "r");
	try {
		const buffer = Buffer.alloc(8192);
		const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
		const header = JSON.parse(buffer.subarray(0, length).toString("utf8").split("\n")[0]);
		if (header.type !== "session" || typeof header.id !== "string")
			throw new Error("Invalid native session header");
		return header.id;
	} finally {
		fs.closeSync(fd);
	}
}

function check(record, owner) {
	// Old localized stamps cannot prove PID reuse. Keep their live PID locked
	// until it exits; only versioned canonical stamps can safely be reclaimed.
	const legacyLivePid = record && !record.birth.startsWith(BIRTH_PREFIX) && processIdentity(record.pid) !== undefined;
	if (record && record.instanceId !== owner.instanceId && (isAlive(record) || legacyLivePid)) {
		const error = new Error(`Session owned by ${record.kind} Pi process ${record.pid}`);
		error.code = "NOT_OWNER";
		error.owner = record;
		throw error;
	}
}

export function acquire(file, owner, root = lockRoot(), expectedId) {
	if (!historyInScope(file)) throw new Error("Native history outside pilot scope");
	return transaction(root, (db) => {
		check(read(db, "namespace"), owner);
		const target = canonicalFile(file);
		check(read(db, target), owner);
		const id = expectedId || sessionId(target);
		if (id) check(read(db, `id:${id}`), owner);
		const record = { ...owner, file: target, sessionId: id, acquiredAt: Date.now() };
		write(db, target, record);
		if (id) write(db, `id:${id}`, record);
		return record;
	});
}

export function reserveNamespace(owner, root = lockRoot()) {
	return transaction(root, (db) => {
		check(read(db, "namespace"), owner);
		write(db, "namespace", owner);
	});
}

export function releaseNamespace(owner, root = lockRoot()) {
	return transaction(root, (db) => {
		if (read(db, "namespace")?.instanceId === owner.instanceId)
			db.prepare("DELETE FROM locks WHERE key='namespace'").run();
	});
}

export function inspect(file, root = lockRoot()) {
	return transaction(root, (db) => {
		const record = read(db, canonicalFile(file));
		return record && isAlive(record) ? record : undefined;
	});
}

export function release(file, owner, root = lockRoot()) {
	return transaction(root, (db) => {
		const key = canonicalFile(file);
		const record = read(db, key);
		if (record?.instanceId === owner.instanceId) {
			db.prepare("DELETE FROM locks WHERE key=?").run(key);
			if (record.sessionId) {
				const idKey = `id:${record.sessionId}`;
				const byId = read(db, idKey);
				if (byId?.instanceId === owner.instanceId && byId.file === key)
					db.prepare("DELETE FROM locks WHERE key=?").run(idKey);
			}
		}
	});
}

/** Child claims inherited locks atomically before importing the Pi executable. */
export function adopt(previous, next, root = lockRoot()) {
	return transaction(root, (db) => {
		let found = false;
		for (const row of db.prepare("SELECT key,record FROM locks").all()) {
			const record = JSON.parse(row.record);
			if (record.instanceId === previous.instanceId) {
				if (record.file && !historyInScope(record.file)) throw new Error("Native history outside pilot scope");
				if (record.pid !== previous.pid || record.birth !== previous.birth)
					throw new Error("Ownership bootstrap identity mismatch");
				write(db, row.key, { ...record, ...next, instanceId: previous.instanceId });
				found = true;
			}
		}
		if (!found) throw new Error("Ownership reservation lost before bootstrap");
	});
}

export function ownedRecord(root = lockRoot()) {
	const value = process.env[OWNERSHIP_ENV];
	if (!value) return undefined;
	const owner = JSON.parse(value);
	if (owner.pid !== process.pid || owner.birth !== processIdentity())
		throw new Error("Invalid inherited Pi ownership");
	return { owner, root };
}

/** Reserve a known native ID before Pi allocates a filename or appends --name. */
export function reserveId(id, owner, root = lockRoot()) {
	return transaction(root, (db) => {
		check(read(db, "namespace"), owner);
		check(read(db, `id:${id}`), owner);
		write(db, `id:${id}`, { ...owner, sessionId: id });
	});
}
