import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { parseCommand } from "./command.ts";
import { acquireProfileLock, FirefoxSession, guardHandoffProfile, releaseProfileLock } from "./firefox-session.ts";
import { nativeLockHolder } from "./profile.ts";

const run = promisify(execFile);
const integration = process.env.PI_FIREFOX_INTEGRATION === "1";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean | Promise<boolean>) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (await predicate()) return;
		await pause(100);
	}
	throw new Error("Firefox handoff proof timed out");
}

/** Close only the normal Firefox belonging to this disposable test profile. */
async function quitFixtureBrowser(profile: string) {
	const pid = await nativeLockHolder(profile);
	if (pid === null) return;
	const args = ["-p", String(pid), "-o", "lstart=", "-o", "command="];
	const { stdout: identity } = await run("ps", args);
	assert.ok(identity.includes(`--profile ${profile} --no-remote`));
	assert.ok(!identity.includes("--marionette"));
	assert.equal((await run("ps", args)).stdout, identity);
	process.kill(pid, "SIGTERM");
	await waitFor(async () => await nativeLockHolder(profile) === null);
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-firefox-normal-handoff-"));
	const profile = join(root, "profile");
	const browser = new FirefoxSession(profile);
	let normalVisits = 0;
	const server = createServer((request, response) => {
		response.setHeader("content-type", "text/html; charset=utf-8");
		if (request.url === "/native-login") {
			normalVisits++;
			response.setHeader("set-cookie", "handoff=verified; Path=/; Max-Age=3600; SameSite=Lax; HttpOnly");
			response.end("ok");
			return;
		}
		const authenticated = request.headers.cookie?.includes("handoff=verified");
		response.end(`<!doctype html><title>${authenticated ? "Authenticated" : "Anonymous"}</title>
			<script>if (!navigator.webdriver) fetch('/native-login');</script>`);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
	return {
		browser, profile, url,
		normalVisits: () => normalVisits,
		async close() {
			if (browser.status().includes("normal Firefox")) await quitFixtureBrowser(profile);
			await browser.shutdown();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(root, { recursive: true, force: true });
		},
	};
}

test("a slow-start handoff guardian outlives reload and releases on confirmed browser exit", { timeout: 15_000 }, async (context) => {
	const root = await mkdtemp(join(tmpdir(), "pi-firefox-lease-guardian-"));
	const profile = join(root, "profile");
	const lock = await acquireProfileLock(profile);
	context.mock.timers.enable({ apis: ["setTimeout"] });
	let exited = false;
	let checks = 0;
	const guardian = guardHandoffProfile(lock, profile, () => { checks++; return exited; });
	let finished = false;
	const settled = guardian.then(() => { finished = true; });
	try {
		// Advance more than the former ten-second shutdown limit while the
		// browser has neither acquired its native lock nor exited.
		while (checks < 110) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			context.mock.timers.tick(100);
		}
		await assert.rejects(acquireProfileLock(profile), /already controlled/);
		exited = true;
		while (!finished) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			context.mock.timers.tick(100);
		}
		await settled;
		const next = await acquireProfileLock(profile);
		await releaseProfileLock(next);
	} finally {
		context.mock.timers.reset();
		await releaseProfileLock(lock);
		await rm(root, { recursive: true, force: true });
	}
});

test("an active sign-in browser retains the lease even after its parent Pi exits", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-firefox-handoff-owner-"));
	const profile = join(root, "profile");
	const lock = await acquireProfileLock(profile);
	try {
		lock.owner.pid = 2_147_483_647;
		lock.owner.handoffPid = process.pid;
		await writeFile(lock.path, JSON.stringify(lock.owner));
		await assert.rejects(acquireProfileLock(profile), /already controlled/);
	} finally {
		await releaseProfileLock(lock);
		await rm(root, { recursive: true, force: true });
	}
});

test("normal Firefox handoff keeps profile ownership and saves login for automation", {
	skip: !integration, timeout: 120_000,
}, async () => {
	const f = await fixture();
	const concurrent = new FirefoxSession(f.profile);
	try {
		assert.match(await f.browser.execute(parseCommand(`open ${f.url}`), async () => false), /Anonymous/);
		const result = await f.browser.execute(parseCommand(`handoff ${f.url}?return=normal`), async ({ message }) => {
			assert.match(message, /normal Firefox/);
			assert.match(message, /quit/i);
			await waitFor(() => f.normalVisits() > 0);
			await assert.rejects(acquireProfileLock(f.profile), /already controlled/);
			const other = await concurrent.execute(parseCommand(`open ${f.url}`), async () => false);
			assert.notEqual(concurrent.profilePath, f.profile);
			assert.match(other, /Anonymous/);
			await concurrent.shutdown();
			await pause(1000);
			await quitFixtureBrowser(f.profile);
			return true;
		});
		assert.match(result, /Automation resumed/);
		assert.match(f.browser.status(), /headless/);
		const snapshot = await f.browser.execute(parseCommand("snapshot"), async () => false);
		assert.match(snapshot, /Authenticated/);
		assert.match(snapshot, /return=normal/);
	} finally {
		await concurrent.shutdown();
		await f.close();
	}
});

test("canceled or premature handoff never kills the manual browser or releases its lease", {
	skip: !integration, timeout: 120_000,
}, async () => {
	const f = await fixture();
	try {
		await f.browser.execute(parseCommand(`open ${f.url}`), async () => false);
		const canceled = new AbortController();
		canceled.abort();
		await assert.rejects(f.browser.execute(parseCommand("handoff"), async () => true, canceled.signal), /aborted/);
		assert.match(f.browser.status(), /headless/);
		assert.equal(f.normalVisits(), 0);
		assert.match(await f.browser.execute(parseCommand("handoff"), async () => false), /canceled/);
		await waitFor(() => f.normalVisits() > 0);
		const normalPid = await nativeLockHolder(f.profile);
		assert.ok(normalPid);
		await assert.rejects(f.browser.start("headless"), /manual sign-in/);
		await assert.rejects(f.browser.close(), /Quit normal Firefox/);
		await assert.rejects(acquireProfileLock(f.profile), /already controlled/);
		await assert.rejects(f.browser.execute(parseCommand("handoff"), async () => true), /Quit normal Firefox/);
		assert.equal(await nativeLockHolder(f.profile), normalPid);
		const controller = new AbortController();
		await assert.rejects(f.browser.execute(parseCommand("handoff"), async () => {
			controller.abort();
			return true;
		}, controller.signal), /aborted/);
		assert.equal(await nativeLockHolder(f.profile), normalPid);
		await quitFixtureBrowser(f.profile);
		assert.match(await f.browser.execute(parseCommand("handoff"), async () => true), /Automation resumed/);
	} finally {
		await f.close();
	}
});


test("shutdown aborts handoff without killing normal Firefox or leaving a live Pi lease", {
	skip: !integration, timeout: 120_000,
}, async () => {
	const f = await fixture();
	const replacement = new FirefoxSession(f.profile);
	try {
		await f.browser.execute(parseCommand(`open ${f.url}`), async () => false);
		let ready!: () => void;
		const entered = new Promise<void>((resolve) => { ready = resolve; });
		const operation = f.browser.execute(parseCommand("handoff"), async (_request, signal) => {
			return await new Promise<boolean>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new Error("handoff aborted")), { once: true });
				ready();
			});
		});
		const interrupted = assert.rejects(operation, /aborted/);
		await entered;
		await waitFor(() => f.normalVisits() > 0);
		const pid = await nativeLockHolder(f.profile);
		await f.browser.shutdown();
		await interrupted;
		assert.equal(await nativeLockHolder(f.profile), pid);
		const lease = await acquireProfileLock(f.profile);
		await releaseProfileLock(lease);
		await assert.rejects(replacement.start("headless"), /not a recorded Pi orphan/);
		await quitFixtureBrowser(f.profile);
		await replacement.start("headless");
		assert.match(await replacement.execute(parseCommand(`open ${f.url}`), async () => false), /Authenticated/);
	} finally {
		await replacement.shutdown();
		await f.close();
	}
});
