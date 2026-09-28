import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, open, readFile, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { Builder, By, Key, type WebDriver } from "selenium-webdriver";
import * as firefox from "selenium-webdriver/firefox";

import type { ParsedCommand } from "./command.ts";
import { formatSnapshot, type SnapshotElement, takeSnapshot } from "./snapshot.ts";

export type BrowserMode = "headed" | "headless";

export function requestedBrowserMode(flag?: string): BrowserMode {
	return flag === "--headed" ? "headed" : "headless";
}

interface LockOwner {
	pid: number;
	token: string;
	startedAt: string;
}

interface ProfileLock {
	path: string;
	owner: LockOwner;
}

export interface HandoffRequest {
	title: string;
	message: string;
}

export type HandoffHandler = (request: HandoffRequest, signal?: AbortSignal) => Promise<boolean>;

function defaultProfilePath(): string {
	if (process.env.PI_FIREFOX_PROFILE) return process.env.PI_FIREFOX_PROFILE;
	if (process.platform === "darwin") {
		return join(homedir(), "Library", "Application Support", "Pi", "firefox-profile");
	}
	const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
	return join(dataHome, "pi", "firefox-profile");
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function createLockFile(path: string, owner: LockOwner): Promise<ProfileLock> {
	const handle = await open(path, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
	} finally {
		await handle.close();
	}
	return { path, owner };
}

async function readLockOwner(path: string, kind: string): Promise<Partial<LockOwner>> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as Partial<LockOwner>;
	} catch (error) {
		throw new Error(`${kind} is unreadable. Verify no Pi Firefox session is active before removing it.`, {
			cause: error,
		});
	}
}

export async function acquireProfileLock(profilePath: string): Promise<ProfileLock> {
	const lockPath = `${profilePath}.pi-lock`;
	const guardPath = `${lockPath}.guard`;
	const owner: LockOwner = { pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() };
	const guardOwner: LockOwner = { pid: process.pid, token: randomUUID(), startedAt: owner.startedAt };
	await mkdir(profilePath, { recursive: true, mode: 0o700 });
	await chmod(profilePath, 0o700);

	let guard: ProfileLock;
	try {
		guard = await createLockFile(guardPath, guardOwner);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const existing = await readLockOwner(guardPath, "Firefox profile acquisition guard");
		const ownerDescription = typeof existing.pid === "number" ? `process ${existing.pid}` : "another process";
		throw new Error(
			`Firefox profile lock is currently being changed by ${ownerDescription}. Retry shortly; if it persists, verify no Pi Firefox session is active.`,
			{ cause: error },
		);
	}

	try {
		try {
			return await createLockFile(lockPath, owner);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const existing = await readLockOwner(lockPath, "Firefox profile lock");
			if (typeof existing.pid === "number" && processIsAlive(existing.pid)) {
				throw new Error(`Firefox profile is already controlled by Pi process ${existing.pid}. Close that session first.`, {
					cause: error,
				});
			}
			await unlink(lockPath);
			return await createLockFile(lockPath, owner);
		}
	} finally {
		await releaseProfileLock(guard);
	}
}

export async function releaseProfileLock(lock: ProfileLock | null): Promise<void> {
	if (!lock) return;
	try {
		const existing = JSON.parse(await readFile(lock.path, "utf8")) as Partial<LockOwner>;
		if (existing.pid !== lock.owner.pid || existing.token !== lock.owner.token) return;
		await unlink(lock.path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function abortError(): Error {
	const error = new Error("browser command aborted");
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

function seleniumManagerExecutable(): string {
	const moduleRequire = createRequire(import.meta.url);
	const packageRoot = dirname(moduleRequire.resolve("selenium-webdriver/package.json"));
	if (process.platform === "darwin") return join(packageRoot, "bin", "macos", "selenium-manager");
	if (process.platform === "win32") return join(packageRoot, "bin", "windows", "selenium-manager.exe");
	const linuxDirectory = process.arch === "arm64" ? "linux-arm64" : "linux-x86_64";
	return join(packageRoot, "bin", linuxDirectory, "selenium-manager");
}

interface SeleniumManagerOutput {
	result?: { driver_path?: string };
}

async function resolveGeckodriver(firefoxBinary: string | undefined, signal?: AbortSignal): Promise<string> {
	const configured = process.env.PI_GECKODRIVER_BIN;
	if (configured) {
		await access(configured, constants.X_OK);
		return configured;
	}
	throwIfAborted(signal);
	const executable = seleniumManagerExecutable();
	await access(executable, constants.X_OK);
	const args = ["--browser", "firefox", "--language-binding", "javascript", "--output", "json"];
	if (firefoxBinary) args.push("--browser-path", firefoxBinary);

	return await new Promise<string>((resolve, reject) => {
		const processHandle = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			processHandle.kill("SIGTERM");
		}, 30_000);
		const onAbort = () => processHandle.kill("SIGTERM");
		signal?.addEventListener("abort", onAbort, { once: true });
		processHandle.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		processHandle.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		processHandle.once("error", (error) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
		processHandle.once("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (signal?.aborted) {
				reject(abortError());
				return;
			}
			if (timedOut) {
				reject(new Error("Selenium Manager timed out while resolving geckodriver"));
				return;
			}
			if (code !== 0) {
				reject(new Error(`Selenium Manager failed: ${stderr.trim() || `exit ${code}`}`));
				return;
			}
			try {
				const output = JSON.parse(stdout) as SeleniumManagerOutput;
				const driverPath = output.result?.driver_path;
				if (!driverPath) throw new Error("Selenium Manager returned no driver path");
				resolve(driverPath);
			} catch (error) {
				reject(new Error("Could not parse Selenium Manager output", { cause: error }));
			}
		});
	});
}

async function freeTcpPort(): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("could not allocate a Marionette port"));
				return;
			}
			const port = address.port;
			server.close((error) => (error ? reject(error) : resolve(port)));
		});
	});
}

function requireArg(args: string[], index: number, usage: string): string {
	const value = args[index];
	if (!value) throw new Error(`usage: ${usage}`);
	return value;
}

function parseRef(value: string): string {
	if (!/^@e[1-9]\d*$/.test(value)) throw new Error(`invalid element ref: ${value}`);
	return value;
}

function parseOpenUrl(value: string): string {
	if (value === "about:blank") return value;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("open requires an absolute http(s) URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("only http(s) URLs and about:blank are allowed");
	}
	return url.href;
}

const NAMED_KEYS: Record<string, string> = {
	enter: Key.ENTER,
	tab: Key.TAB,
	escape: Key.ESCAPE,
	space: Key.SPACE,
	backspace: Key.BACK_SPACE,
	delete: Key.DELETE,
	arrowup: Key.ARROW_UP,
	arrowdown: Key.ARROW_DOWN,
	arrowleft: Key.ARROW_LEFT,
	arrowright: Key.ARROW_RIGHT,
	home: Key.HOME,
	end: Key.END,
	pageup: Key.PAGE_UP,
	pagedown: Key.PAGE_DOWN,
};

function keyFor(value: string): string {
	const key = NAMED_KEYS[value.toLowerCase()];
	if (!key) throw new Error(`unsupported key: ${value}`);
	return key;
}

async function pause(milliseconds: number): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export class FirefoxSession {
	readonly profilePath: string;
	private driver: WebDriver | null = null;
	private mode: BrowserMode | null = null;
	private lock: ProfileLock | null = null;
	private startup: Promise<void> | null = null;
	private startupController: AbortController | null = null;
	private refs = new Map<string, SnapshotElement>();

	constructor(profilePath = defaultProfilePath()) {
		this.profilePath = profilePath;
	}

	private async startDriver(mode: BrowserMode, lock: ProfileLock, signal: AbortSignal): Promise<void> {
		let builtDriver: WebDriver | null = null;
		try {
			throwIfAborted(signal);
			const marionettePort = await freeTcpPort();
			const options = new firefox.Options()
				.addArguments("--profile", this.profilePath, "--marionette-port", String(marionettePort), "--no-remote")
				.setPreference("browser.shell.checkDefaultBrowser", false)
				.setPreference("browser.aboutwelcome.enabled", false)
				.setPreference("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
			if (mode === "headless") options.addArguments("-headless");

			const firefoxBinary = process.env.PI_FIREFOX_BIN;
			if (firefoxBinary) {
				await access(firefoxBinary, constants.X_OK);
				options.setBinary(firefoxBinary);
			}
			const geckodriverBinary = await resolveGeckodriver(firefoxBinary, signal);
			throwIfAborted(signal);
			const builder = new Builder()
				.forBrowser("firefox")
				.setFirefoxOptions(options)
				.setFirefoxService(new firefox.ServiceBuilder(geckodriverBinary));

			builtDriver = await builder.build();
			throwIfAborted(signal);
			await builtDriver.manage().setTimeouts({ implicit: 0, pageLoad: 45_000, script: 15_000 });
			throwIfAborted(signal);
			this.driver = builtDriver;
			builtDriver = null;
			this.mode = mode;
			this.refs.clear();
		} catch (error) {
			await builtDriver?.quit().catch(() => undefined);
			if (this.lock === lock) {
				this.lock = null;
				await releaseProfileLock(lock);
			}
			throw error;
		}
	}

	async start(mode: BrowserMode, signal?: AbortSignal): Promise<string> {
		if (this.driver) {
			if (this.mode !== mode) throw new Error(`Firefox is already running ${this.mode}; close it before changing mode.`);
			return this.status();
		}
		if (this.startup) throw new Error("Firefox is already starting.");

		const lock = await acquireProfileLock(this.profilePath);
		this.lock = lock;
		const controller = new AbortController();
		const onAbort = () => controller.abort(signal?.reason);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		this.startupController = controller;
		const startup = this.startDriver(mode, lock, controller.signal);
		this.startup = startup;
		try {
			await startup;
			return [
				`Firefox started in ${mode} mode.`,
				`Profile: ${this.profilePath}`,
				mode === "headed"
					? "Use `handoff` when you need to unlock Bitwarden or trigger its autofill UI."
					: "Bitwarden cannot be interactively unlocked in headless mode; existing browser sessions may still work.",
			].join("\n");
		} finally {
			signal?.removeEventListener("abort", onAbort);
			if (this.startup === startup) this.startup = null;
			if (this.startupController === controller) this.startupController = null;
		}
	}

	status(): string {
		if (!this.driver) return `Firefox is stopped.\nProfile: ${this.profilePath}`;
		return `Firefox is running in ${this.mode} mode.\nProfile: ${this.profilePath}`;
	}

	async close(): Promise<string> {
		this.startupController?.abort(abortError());
		await this.startup?.catch(() => undefined);
		const driver = this.driver;
		const lock = this.lock;
		this.driver = null;
		this.mode = null;
		this.lock = null;
		this.refs.clear();
		try {
			await driver?.quit();
		} catch {
			// Firefox may already have been closed manually.
		} finally {
			await releaseProfileLock(lock);
		}
		return "Firefox closed.";
	}

	private requireDriver(): WebDriver {
		if (!this.driver) throw new Error("Firefox is not running. Use `start`, `start --headed`, or `open <url>` first.");
		return this.driver;
	}

	private requireRef(value: string): SnapshotElement {
		const ref = parseRef(value);
		const entry = this.refs.get(ref);
		if (!entry) throw new Error(`${ref} is unavailable or stale; run snapshot again.`);
		return entry;
	}

	private assertWritable(entry: SnapshotElement): void {
		if (entry.sensitive) {
			throw new Error(`${entry.ref} is a password or credential field. Use headed Bitwarden handoff instead.`);
		}
		if (entry.disabled) throw new Error(`${entry.ref} is disabled.`);
	}

	private async snapshot(): Promise<string> {
		const snapshot = await takeSnapshot(this.requireDriver());
		this.refs = new Map(snapshot.elements.map((entry) => [entry.ref, entry]));
		return formatSnapshot(snapshot);
	}

	private async snapshotAfterAction(): Promise<string> {
		await pause(250);
		return await this.snapshot();
	}

	async execute(command: ParsedCommand, handoff: HandoffHandler, signal?: AbortSignal): Promise<string> {
		const { name, args } = command;
		if (name === "help") {
			return [
				"Firefox web_browse commands:",
				"  start [--headed|--headless] | status | close",
				"  open <https-url> | snapshot | back | forward | reload | wait <ms>",
				"  click @eN | fill @eN <text> | type @eN <text> | press [@eN] <key>",
				"  select @eN <option> | check @eN | uncheck @eN | handoff",
				"Password fields, cookies, storage, arbitrary JavaScript, network bodies, and screenshots are not exposed.",
			].join("\n");
		}
		if (name === "status") return this.status();
		if (name === "close") return await this.close();
		if (name === "start") {
			if (args.length > 1 || (args[0] && args[0] !== "--headed" && args[0] !== "--headless")) {
				throw new Error("usage: start [--headed|--headless]");
			}
			return await this.start(requestedBrowserMode(args[0]), signal);
		}
		if (name === "open") {
			if (args.length !== 1) throw new Error("usage: open <https-url>");
			if (!this.driver) await this.start("headless", signal);
			await this.requireDriver().get(parseOpenUrl(args[0]));
			return await this.snapshot();
		}
		if (name === "snapshot") return await this.snapshot();
		if (name === "back" || name === "forward" || name === "reload") {
			if (args.length !== 0) throw new Error(`usage: ${name}`);
			const navigation = this.requireDriver().navigate();
			if (name === "back") await navigation.back();
			else if (name === "forward") await navigation.forward();
			else await navigation.refresh();
			return await this.snapshotAfterAction();
		}
		if (name === "wait") {
			if (args.length !== 1 || !/^\d+$/.test(args[0])) throw new Error("usage: wait <milliseconds>");
			const milliseconds = Number(args[0]);
			if (milliseconds > 600_000) throw new Error("wait is limited to 600000 milliseconds");
			await pause(milliseconds);
			return await this.snapshot();
		}
		if (name === "click") {
			if (args.length !== 1) throw new Error("usage: click @eN");
			await this.requireRef(args[0]).element.click();
			return await this.snapshotAfterAction();
		}
		if (name === "fill" || name === "type") {
			if (args.length < 2) throw new Error(`usage: ${name} @eN <text>`);
			const entry = this.requireRef(args[0]);
			this.assertWritable(entry);
			if (name === "fill") await entry.element.clear();
			await entry.element.sendKeys(args.slice(1).join(" "));
			return `${name === "fill" ? "Filled" : "Typed into"} ${entry.ref}; text was not echoed.`;
		}
		if (name === "press") {
			if (args.length < 1 || args.length > 2) throw new Error("usage: press [@eN] <key>");
			const hasRef = args[0].startsWith("@e");
			const element = hasRef ? this.requireRef(args[0]).element : await this.requireDriver().switchTo().activeElement();
			const key = keyFor(requireArg(args, hasRef ? 1 : 0, "press [@eN] <key>"));
			await element.sendKeys(key);
			return await this.snapshotAfterAction();
		}
		if (name === "select") {
			if (args.length < 2) throw new Error("usage: select @eN <option>");
			const entry = this.requireRef(args[0]);
			this.assertWritable(entry);
			const wanted = args.slice(1).join(" ");
			const options = await entry.element.findElements(By.css("option"));
			for (const option of options) {
				if ((await option.getText()) === wanted || (await option.getAttribute("value")) === wanted) {
					await option.click();
					return `Selected an option in ${entry.ref}; option text was not echoed.`;
				}
			}
			throw new Error(`no matching option found in ${entry.ref}`);
		}
		if (name === "check" || name === "uncheck") {
			if (args.length !== 1) throw new Error(`usage: ${name} @eN`);
			const entry = this.requireRef(args[0]);
			this.assertWritable(entry);
			const selected = await entry.element.isSelected();
			if ((name === "check" && !selected) || (name === "uncheck" && selected)) await entry.element.click();
			return `${name === "check" ? "Checked" : "Unchecked"} ${entry.ref}.`;
		}
		if (name === "handoff") {
			if (args.length !== 0) throw new Error("usage: handoff");
			this.requireDriver();
			if (this.mode !== "headed") throw new Error("Bitwarden handoff requires headed Firefox.");
			const accepted = await handoff(
				{
					title: "Firefox handoff",
					message:
						"Use the Firefox window now. Unlock Bitwarden and trigger autofill there; never paste a password into Pi. Return here and confirm only when the page is ready for automation.",
				},
				signal,
			);
			this.refs.clear();
			return accepted ? "Handoff complete. Run snapshot to continue." : "Handoff canceled.";
		}
		throw new Error(`unknown command: ${name}. Use \`help\` for the Firefox command list.`);
	}
}
