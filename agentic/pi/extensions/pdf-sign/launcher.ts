/** Native-helper build/lifecycle seam. No page text, images, or strokes cross it. */
import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const native = path.join(__dirname, "native");
let building: Promise<string> | undefined;

export type SigningResult = { status: "cancelled" } | { status: "exported"; path: string };

export async function resolvePDF(input: string, cwd: string): Promise<string> {
	if (!input.trim()) throw new Error("Specify a PDF path.");
	const expanded = input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input;
	const source = path.resolve(cwd, expanded);
	if (path.extname(source).toLowerCase() !== ".pdf") throw new Error("Choose a PDF file.");
	const info = await stat(source);
	if (!info.isFile()) throw new Error("Choose a PDF file, not a directory.");
	const file = await open(source, "r");
	try {
		const header = Buffer.alloc(1024);
		const { bytesRead } = await file.read(header, 0, header.length, 0);
		if (!header.subarray(0, bytesRead).includes(Buffer.from("%PDF-"))) throw new Error("The file is not a PDF.");
	} finally { await file.close(); }
	return source;
}

async function sourceFingerprint(): Promise<string> {
	const hash = createHash("sha256");
	for (const name of ["Package.swift", "Info.plist", ...(await readdir(path.join(native, "Sources", "PDFSigner"))).filter((name) => name.endsWith(".swift")).sort().map((name) => path.join("Sources", "PDFSigner", name))]) {
		hash.update(name);
		hash.update(await readFile(path.join(native, name)));
	}
	return hash.digest("hex");
}

async function buildHelper(): Promise<string> {
	const fingerprint = await sourceFingerprint();
	const app = path.join(native, ".build", "apps", fingerprint, "Pi PDF Signer.app");
	const executable = path.join(app, "Contents", "MacOS", "PDFSigner");
	const ready = path.join(path.dirname(app), ".ready");
	try { await access(ready); await access(executable); return executable; } catch { /* Build on first use or a source change. */ }
	try {
		await exec("/usr/bin/xcrun", ["swift", "build", "--package-path", native, "-c", "release"], { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
		const { stdout } = await exec("/usr/bin/xcrun", ["swift", "build", "--package-path", native, "-c", "release", "--show-bin-path"], { timeout: 30_000 });
		await mkdir(path.dirname(executable), { recursive: true });
		const staged = `${executable}.${randomUUID()}`;
		await copyFile(path.join(stdout.trim(), "PDFSigner"), staged);
		await rename(staged, executable);
		await copyFile(path.join(native, "Info.plist"), path.join(app, "Contents", "Info.plist"));
		await writeFile(path.join(app, "Contents", "PkgInfo"), "APPL????");
		await exec("/usr/bin/codesign", ["--force", "--sign", "-", app], { timeout: 30_000 });
		await writeFile(ready, fingerprint);
		return executable;
	} catch {
		throw new Error("Could not build Pi PDF Signer. Check that Xcode Command Line Tools are installed and xcrun swift build works.");
	}
}

export function parseSigningResult(stdout: string): SigningResult {
	let value: unknown;
	try { value = JSON.parse(stdout.trim()); } catch { throw new Error("The PDF editor returned an invalid result."); }
	if (!value || typeof value !== "object") throw new Error("The PDF editor returned an invalid result.");
	const result = value as Record<string, unknown>;
	if (result.status === "cancelled") return { status: "cancelled" };
	if (result.status === "exported" && typeof result.path === "string" && path.isAbsolute(result.path)) {
		return { status: "exported", path: result.path };
	}
	if (result.status === "error") throw new Error("The PDF editor could not open this file. Check that it is a readable, unrestricted PDF.");
	throw new Error("The PDF editor returned an invalid result.");
}

export function runHelper(executable: string, source: string, signal?: AbortSignal): Promise<SigningResult> {
	if (signal?.aborted) return Promise.reject(new Error("PDF signing cancelled."));
	return new Promise((resolve, reject) => {
		const child = spawn(executable, ["--input", source], { stdio: ["ignore", "pipe", "ignore"] });
		let stdout = "";
		let overflow = false;
		let forceKill: ReturnType<typeof setTimeout> | undefined;
		const abort = () => {
			child.kill("SIGTERM");
			forceKill ??= setTimeout(() => child.kill("SIGKILL"), 3_000);
			forceKill.unref();
		};
		const cleanup = () => {
			signal?.removeEventListener("abort", abort);
			if (forceKill) clearTimeout(forceKill);
		};
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (data: string) => {
			if (stdout.length + data.length > 16_384) { overflow = true; abort(); }
			else stdout += data;
		});
		child.once("error", () => { cleanup(); reject(new Error("Could not launch the local PDF editor.")); });
		child.once("close", (code) => {
			cleanup();
			if (signal?.aborted) { reject(new Error("PDF signing cancelled.")); return; }
			if (overflow || code !== 0) { reject(new Error("The PDF editor closed unexpectedly. No signing result was returned.")); return; }
			try { resolve(parseSigningResult(stdout)); } catch (error) { reject(error); }
		});
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
	});
}

export async function launchSigner(source: string, signal?: AbortSignal): Promise<SigningResult> {
	if (signal?.aborted) throw new Error("PDF signing cancelled.");
	building ??= buildHelper().finally(() => { building = undefined; });
	const executable = await building;
	if (signal?.aborted) throw new Error("PDF signing cancelled.");
	const result = await runHelper(executable, source, signal);
	if (result.status === "exported" && !(await stat(result.path)).isFile()) throw new Error("The signed PDF was not found after export.");
	return result;
}
