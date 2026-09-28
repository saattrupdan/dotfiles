import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { WebElement } from "selenium-webdriver";

import { parseCommand, safeCommandPreview } from "./command.ts";
import { acquireProfileLock, FirefoxSession, releaseProfileLock, requestedBrowserMode } from "./firefox-session.ts";
import { formatSnapshot, type BrowserSnapshot } from "./snapshot.ts";

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
