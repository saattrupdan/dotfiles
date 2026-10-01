import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { WebElement } from "selenium-webdriver";

import { parseCommand, safeCommandPreview } from "./command.ts";
import { acquireProfileLock, FirefoxSession, releaseProfileLock, requestedBrowserMode } from "./firefox-session.ts";
import { formatSnapshot, type BrowserSnapshot } from "./snapshot.ts";
import { isOrphanedPiFirefox, nativeLockHolder, newSecondaryProfile, recordFirefoxOwner, recoverOrphanedFirefox, refreshSeed, removeSecondaryProfile } from "./profile.ts";

test("parseCommand handles quoted and escaped arguments without a shell", () => {
	assert.deepEqual(parseCommand(`fill @e2 "hello world"`), {
		name: "fill",
		args: ["@e2", "hello world"],
	});
	assert.deepEqual(parseCommand(`open https://example.com/a\\ b`), {
		name: "open",
		args: ["https://example.com/a b"],
	});
	assert.throws(() => parseCommand(`fill @e1 "unterminated`), /unterminated/);
});

test("safeCommandPreview never echoes form payloads", () => {
	assert.equal(safeCommandPreview(`fill @e2 "correct horse battery staple"`), "fill @e2 [text redacted]");
	assert.equal(safeCommandPreview(`type @e4 secret`), "type @e4 [text redacted]");
	assert.equal(safeCommandPreview(`select @e5 Private account`), "select @e5 [text redacted]");
	assert.equal(safeCommandPreview("snapshot"), "snapshot");
});

test("Firefox defaults to headless mode", () => {
	assert.equal(requestedBrowserMode(), "headless");
	assert.equal(requestedBrowserMode("--headless"), "headless");
	assert.equal(requestedBrowserMode("--headed"), "headed");
});

test("formatSnapshot marks credential fields without exposing a value", () => {
	const element = {} as WebElement;
	const snapshot: BrowserSnapshot = {
		url: "https://example.com/login",
		title: "Sign in",
		text: "Sign in to continue",
		truncated: false,
		elements: [
			{
				ref: "@e1",
				element,
				tag: "input",
				role: "textbox",
				name: "Password",
				type: "password",
				autocomplete: "current-password",
				disabled: false,
				checked: null,
				href: "",
				sensitive: true,
			},
		],
	};
	const formatted = formatSnapshot(snapshot);
	assert.match(formatted, /@e1 textbox “Password” \[type=password, password redacted\]/);
	assert.doesNotMatch(formatted, /value=/);
});

test("profile lock is exclusive and ownership-safe", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-firefox-lock-"));
	const profile = join(root, "profile");
	const first = await acquireProfileLock(profile);
	await assert.rejects(acquireProfileLock(profile), /already controlled/);

	const lockContents = JSON.parse(await readFile(`${profile}.pi-lock`, "utf8")) as { token: string };
	assert.equal(typeof lockContents.token, "string");
	await releaseProfileLock(first);

	const second = await acquireProfileLock(profile);
	await writeFile(
		`${profile}.pi-lock`,
		`${JSON.stringify({ pid: process.pid, token: "different-owner", startedAt: new Date().toISOString() })}\n`,
		"utf8",
	);
	await releaseProfileLock(second);
	assert.equal(JSON.parse(await readFile(`${profile}.pi-lock`, "utf8")).token, "different-owner");
	await rm(root, { recursive: true, force: true });
});

test("only one concurrent caller can replace a stale profile lock", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-firefox-stale-lock-"));
	const profile = join(root, "profile");
	await writeFile(
		`${profile}.pi-lock`,
		`${JSON.stringify({ pid: 2_000_000_000, token: "stale", startedAt: "2000-01-01T00:00:00.000Z" })}\n`,
		"utf8",
	);
	const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => acquireProfileLock(profile)));
	const winners = attempts.filter((attempt) => attempt.status === "fulfilled");
	assert.equal(winners.length, 1);
	if (winners[0].status === "fulfilled") await releaseProfileLock(winners[0].value);
	await rm(root, { recursive: true, force: true });
});

test("profile clones retain logins but omit caches, locks and symlinks", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-firefox-clone-"));
	const primary = join(root, "profile");
	await mkdir(join(primary, "cache2"), { recursive: true });
	await writeFile(join(primary, "cookies.sqlite"), "session-cookie");
	await writeFile(join(primary, "key4.db"), "login-key");
	await writeFile(join(primary, "cache2", "image"), "discard");
	await writeFile(join(primary, ".parentlock"), "");
	await symlink(join(root, "outside"), join(primary, "linked"));
	try {
		await refreshSeed(primary);
		const secondary = await newSecondaryProfile(primary);
		assert.equal(await readFile(join(secondary, "cookies.sqlite"), "utf8"), "session-cookie");
		assert.equal(await readFile(join(secondary, "key4.db"), "utf8"), "login-key");
		assert.equal((await stat(secondary)).mode & 0o777, 0o700);
		for (const name of ["cache2", ".parentlock", "linked"]) {
			await assert.rejects(stat(join(secondary, name)), /ENOENT/);
		}
		await removeSecondaryProfile(primary, secondary);
		await assert.rejects(stat(secondary), /ENOENT/);
		await assert.rejects(removeSecondaryProfile(primary, primary), /Refusing to delete/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("only orphaned tool-launched Firefox matches automatic recovery", () => {
	const profile = "/tmp/pi profile";
	const command = `/Applications/Firefox.app/Contents/MacOS/firefox --marionette --profile ${profile} --marionette-port 1234 --no-remote`;
	assert.equal(isOrphanedPiFirefox(command, 1, profile), true);
	assert.equal(isOrphanedPiFirefox(command, 42, profile), false);
	assert.equal(isOrphanedPiFirefox(command, 1, "/tmp/other"), false);
	assert.equal(isOrphanedPiFirefox(command.replace("--no-remote", ""), 1, profile), false);
	assert.equal(isOrphanedPiFirefox(`firefox --profile ${profile}`, 1, profile), false);
});

test(
	"a verified orphaned Firefox releases its native profile lock automatically",
	{ skip: process.env.PI_FIREFOX_INTEGRATION !== "1" || process.platform !== "darwin", timeout: 30_000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-firefox-orphan-"));
		const profile = join(root, "profile");
		await mkdir(profile);
		const binary = process.env.PI_FIREFOX_BIN ?? "/Applications/Firefox.app/Contents/MacOS/firefox";
		// Launch in a short-lived controller so Firefox is reparented to init, as after a crash.
		const launcher = spawn(process.execPath, ["-e", `
			const { spawn } = require("node:child_process");
			const child = spawn(process.argv[1], ["--marionette", "--profile", process.argv[2], "--marionette-port", "0", "--no-remote", "-headless"], { detached: true, stdio: "ignore" });
			child.unref(); console.log(child.pid);
		`, binary, profile], { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		for await (const chunk of launcher.stdout) output += chunk.toString();
		const pid = Number(output.trim());
		assert.ok(Number.isInteger(pid) && pid > 0);
		try {
			let holder: number | null = null;
			for (let attempt = 0; attempt < 100; attempt++) {
				holder = await nativeLockHolder(profile);
				if (holder === pid) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			assert.equal(holder, pid);
			await assert.rejects(recoverOrphanedFirefox(profile), /not a recorded Pi orphan/);
			await recordFirefoxOwner(profile);
			assert.equal(await recoverOrphanedFirefox(profile), pid);
			assert.equal(await nativeLockHolder(profile), null);
		} finally {
			if (await nativeLockHolder(profile) === pid) process.kill(pid, "SIGTERM");
			await rm(root, { recursive: true, force: true });
		}
	},
);

test(
	"headed and headless Firefox work while credential entry stays blocked",
	{ skip: process.env.PI_FIREFOX_INTEGRATION !== "1", timeout: 120_000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-firefox-integration-"));
		const browser = new FirefoxSession(join(root, "profile"));
		const server = createServer((_request, response) => {
			response.setHeader("content-type", "text/html; charset=utf-8");
			response.end(`<!doctype html><title>Login test</title>
				<label>Name <input aria-label="Name"></label>
				<label>Password <input type="password" aria-label="Password" value="not-visible"></label>
				<label>PIN <input name="code"></label>
				<label>OTP <input autocomplete="one-time-code"></label>
				<button onclick="document.title='Done'">Continue</button>`);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address() as AddressInfo;
		try {
			const opened = await browser.execute(parseCommand(`open http://127.0.0.1:${address.port}`), async () => false);
			assert.match(browser.status(), /running in headless mode/);
			assert.match(opened, /@e1 textbox “Name”/);
			assert.match(opened, /@e2 textbox “Password” \[type=password, password redacted\]/);
			assert.match(opened, /@e3 textbox “PIN” \[password redacted\]/);
			assert.match(opened, /@e4 textbox “OTP” \[password redacted\]/);
			assert.doesNotMatch(opened, /not-visible/);
			assert.match(await browser.execute(parseCommand("fill @e1 Alice"), async () => false), /text was not echoed/);
			for (const ref of ["@e2", "@e3", "@e4"]) {
				await assert.rejects(
					browser.execute(parseCommand(`fill ${ref} should-not-be-sent`), async () => false),
					/credential field/,
				);
			}
			assert.match(await browser.execute(parseCommand("click @e5"), async () => false), /# Done/);
			await browser.close();
			assert.match(await browser.start("headed"), /headed mode/);
			assert.match(browser.status(), /running in headed mode/);
		} finally {
			await browser.close();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			await rm(root, { recursive: true, force: true });
		}
	},
);

test(
	"concurrent Firefox sessions use isolated profiles with seeded login state",
	{ skip: process.env.PI_FIREFOX_INTEGRATION !== "1", timeout: 120_000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-firefox-concurrent-"));
		const primary = join(root, "profile");
		const first = new FirefoxSession(primary);
		const second = new FirefoxSession(primary);
		const afterLogout = new FirefoxSession(primary);
		const server = createServer((request, response) => {
			response.setHeader("content-type", "text/html; charset=utf-8");
			if (request.url === "/login") {
				response.setHeader("set-cookie", "session=approved; Path=/; Max-Age=3600; SameSite=Lax");
				response.end("<!doctype html><title>Logged in</title>");
			} else if (request.url === "/logout") {
				response.setHeader("set-cookie", "session=; Path=/; Max-Age=0; SameSite=Lax");
				response.end("<!doctype html><title>Logged out</title>");
			} else {
				response.end(`<!doctype html><title>${request.headers.cookie?.includes("session=approved") ? "Authenticated" : "Anonymous"}</title>`);
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address() as AddressInfo;
		try {
			// Simulate a simultaneous Pi process acquiring the primary lock.
			await mkdir(primary);
			await writeFile(`${primary}.pi-lock.guard`, JSON.stringify({ pid: process.pid, token: "guard" }));
			const releaseGuard = setTimeout(() => { void rm(`${primary}.pi-lock.guard`, { force: true }); }, 300);
			try {
				await first.execute(parseCommand(`open http://127.0.0.1:${address.port}/login`), async () => false);
			} finally {
				clearTimeout(releaseGuard);
				await rm(`${primary}.pi-lock.guard`, { force: true });
			}
			assert.equal(typeof JSON.parse(await readFile(`${primary}.pi-firefox-owner`, "utf8")).pid, "number");
			await first.close(); // Refresh the quiescent seed after the login.
			await assert.rejects(stat(`${primary}.pi-firefox-owner`), /ENOENT/);
			assert.match(await first.execute(parseCommand(`open http://127.0.0.1:${address.port}/`), async () => false), /Authenticated/);
			assert.match(await second.execute(parseCommand(`open http://127.0.0.1:${address.port}/`), async () => false), /Authenticated/);
			assert.notEqual(first.profilePath, second.profilePath);
			assert.equal(await nativeLockHolder(first.profilePath) !== null, true);
			assert.equal(await nativeLockHolder(second.profilePath) !== null, true);
			await second.shutdown();
			assert.match(await first.execute(parseCommand("snapshot"), async () => false), /Authenticated/);
			await assert.rejects(stat(second.profilePath), /ENOENT/);
			await first.execute(parseCommand(`open http://127.0.0.1:${address.port}/logout`), async () => false);
			await first.close(); // Refresh the seed after logout too; do not retain stale credentials.
			await first.start("headless");
			assert.match(await afterLogout.execute(parseCommand(`open http://127.0.0.1:${address.port}/`), async () => false), /Anonymous/);
		} finally {
			await first.shutdown();
			await second.shutdown();
			await afterLogout.shutdown();
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
			await rm(root, { recursive: true, force: true });
		}
	},
);
