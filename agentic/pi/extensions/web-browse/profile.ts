/* Profile isolation and conservative recovery for Firefox sessions. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, join } from "node:path";

const run = promisify(execFile);
const IGNORED = new Set([
	".parentlock", "lock", "cache2", "startupCache", "crashes", "datareporting",
	"minidumps", "safebrowsing", "shader-cache", "sessionstore-backups",
	"sessionstore.jsonlz4", "Telemetry.FailedProfileLocks.txt",
]);

/** Native Firefox locks are authoritative; never unlink them. null means no holder. */
export async function nativeLockHolder(profile: string): Promise<number | null> {
	try {
		await stat(join(profile, ".parentlock"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	let output: string;
	try {
		({ stdout: output } = await run("lsof", ["-t", join(profile, ".parentlock")], { timeout: 5_000 }));
	} catch (error) {
		if (String((error as { code?: string | number }).code) === "1") return null;
		throw new Error("Cannot check Firefox's native profile lock (lsof unavailable or failed)", { cause: error });
	}
	const pids = [...new Set(output.trim().split(/\s+/).filter(Boolean))];
	if (pids.length !== 1 || !/^\d+$/.test(pids[0])) throw new Error("Ambiguous Firefox profile lock owners; refusing recovery");
	return Number(pids[0]);
}

/** Match the tool's launch arguments and orphaned parent; ownership is checked separately. */
export function isOrphanedPiFirefox(command: string, ppid: number, profile: string): boolean {
	return ppid === 1 && /(?:^|\/)firefox\s/.test(command) &&
		command.includes(`--profile ${profile} --marionette-port `) &&
		command.includes("--marionette") && command.includes("--no-remote");
}

interface FirefoxIdentity { pid: number; started: string; ppid: number; command: string }

async function firefoxIdentity(pid: number): Promise<FirefoxIdentity | null> {
	try {
		// lstart is localised and variable-width; fetch it separately from the command.
		const { stdout: startOutput } = await run("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 5_000 });
		const { stdout } = await run("ps", ["-p", String(pid), "-o", "ppid=", "-o", "command="], { timeout: 5_000 });
		const started = startOutput.trim();
		const match = stdout.trim().match(/^(\d+)\s+([\s\S]+)$/);
		return match && started ? { pid, started, ppid: Number(match[1]), command: match[2] } : null;
	} catch {
		return null;
	}
}

function ownerPath(profile: string): string {
	return `${profile}.pi-firefox-owner`;
}

/** Record the browser identity while the current Pi process still controls its lock. */
export async function recordFirefoxOwner(profile: string): Promise<void> {
	const pid = await nativeLockHolder(profile);
	const identity = pid && await firefoxIdentity(pid);
	if (!identity || !identity.command.includes(`--profile ${profile} --marionette-port `)) {
		throw new Error("Cannot verify launched Firefox process; refusing untracked browser session");
	}
	await writeFile(ownerPath(profile), `${JSON.stringify(identity)}\n`, { mode: 0o600 });
}

export async function clearFirefoxOwner(profile: string): Promise<void> {
	await rm(ownerPath(profile), { force: true });
}

async function recordedOrphan(pid: number, profile: string): Promise<boolean> {
	try {
		const recorded = JSON.parse(await readFile(ownerPath(profile), "utf8")) as FirefoxIdentity;
		const current = await firefoxIdentity(pid);
		return !!current && recorded.pid === pid && recorded.started === current.started &&
			recorded.command === current.command && isOrphanedPiFirefox(current.command, current.ppid, profile);
	} catch {
		return false;
	}
}

/** Called only after acquiring the Pi lock for this profile. Never signal an ambiguous owner. */
export async function recoverOrphanedFirefox(profile: string, signal?: AbortSignal): Promise<number | null> {
	const pid = await nativeLockHolder(profile);
	if (pid === null) return null;
	if (!await recordedOrphan(pid, profile)) {
		throw new Error(`Firefox profile is held by process ${pid}, which is not a recorded Pi orphan. Close that browser session before retrying.`);
	}
	// Recheck the native lock and process identity immediately before signalling.
	if (signal?.aborted) throw new Error("Firefox startup canceled");
	if (await nativeLockHolder(profile) !== pid || !await recordedOrphan(pid, profile)) {
		throw new Error("Firefox profile owner changed during recovery; retry without terminating any process.");
	}
	process.kill(pid, "SIGTERM");
	for (let attempt = 0; attempt < 50; attempt++) {
		if (signal?.aborted) throw new Error("Firefox startup canceled");
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (await nativeLockHolder(profile) === null) {
			await clearFirefoxOwner(profile);
			return pid;
		}
	}
	throw new Error(`Orphaned Firefox process ${pid} did not release the profile; close it manually.`);
}

export function seedPath(profile: string): string {
	return `${profile}.pi-seed`;
}

export async function invalidateSeed(profile: string): Promise<void> {
	await rm(seedPath(profile), { recursive: true, force: true });
}

/** Copy only a stopped profile. Secrets remain inside a 0700 directory. */
export async function copyProfile(source: string, destination: string): Promise<void> {
	await mkdir(destination, { mode: 0o700 });
	await cp(source, destination, {
		recursive: true,
		force: false,
		filter: async (path) => {
			if (path === source) return true;
			const name = basename(path);
			if (IGNORED.has(name) || name.endsWith(".pi-lock") || name.endsWith(".pi-lock.guard") || name.endsWith("-shm")) return false;
			return !(await lstat(path)).isSymbolicLink();
		},
	});
}

export async function refreshSeed(profile: string): Promise<void> {
	if (await nativeLockHolder(profile) !== null) throw new Error("Cannot seed from a running Firefox profile");
	const seed = seedPath(profile);
	const staged = `${seed}.staging-${randomUUID()}`;
	const old = `${seed}.old-${randomUUID()}`;
	try {
		await copyProfile(profile, staged);
		if (await nativeLockHolder(profile) !== null) throw new Error("Firefox profile became active during seeding");
		let hadOld = false;
		try {
			await rename(seed, old);
			hadOld = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		try {
			await rename(staged, seed);
		} catch (error) {
			if (hadOld) await rename(old, seed);
			throw error;
		}
		if (hadOld) await rm(old, { recursive: true, force: true });
	} finally {
		await rm(staged, { recursive: true, force: true });
	}
}

export async function newSecondaryProfile(profile: string): Promise<string> {
	const seed = seedPath(profile);
	const root = `${profile}.pi-agents`;
	await mkdir(root, { recursive: true, mode: 0o700 });	const destination = join(root, randomUUID());
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			await stat(seed);
			await copyProfile(seed, destination);
			return destination;
		} catch (error) {
			await rm(destination, { recursive: true, force: true });
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			// The primary may have atomically replaced its seed during our copy.
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	throw new Error("Primary Firefox is busy and no quiescent login seed exists yet. Close it once, then start web_browse again to prepare a seed.");
}

export async function removeSecondaryProfile(primary: string, secondary: string): Promise<void> {
	if (dirname(secondary) !== `${primary}.pi-agents` || basename(secondary) === "") {
		throw new Error("Refusing to delete a profile outside the Pi agent directory");
	}
	await rm(secondary, { recursive: true, force: true });
}
