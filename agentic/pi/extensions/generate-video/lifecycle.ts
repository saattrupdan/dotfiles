/** SSH-owned H3 lease: coordinate Pi sessions; server code owns idle expiration. */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

export const SPARKIE_VIDEO_ENDPOINT = "http://100.102.237.34:31000";
export type ReleaseVideoServer = (preserve: boolean) => Promise<string[]>;
export type AcquireVideoServer = (signal: AbortSignal) => Promise<ReleaseVideoServer>;

export const acquireSparkie: AcquireVideoServer = async (signal) => {
	signal.throwIfAborted();
	const script = await readFile(new URL("./sparkie-lease.sh", import.meta.url), "utf8");
	signal.throwIfAborted();
	const quoted = `'${script.replaceAll("'", "'\\''")}'`;
	const child = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
		"-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3", "sparkie", `bash -c ${quoted}`], { stdio: "pipe" });
	const warnings: string[] = [];
	let diagnostic = "";
	let ready = false;
	let settleReady: () => void;
	let rejectReady: (error: Error) => void;
	const readiness = new Promise<void>((resolve, reject) => { settleReady = resolve; rejectReady = reject; });
	child.stderr.on("data", (data: Buffer) => { diagnostic = (diagnostic + data.toString()).slice(-8000); });
	const lines = createInterface({ input: child.stdout });
	lines.on("line", (line) => {
		if (line === "READY") { ready = true; settleReady(); }
		else if (line.startsWith("WARNING ")) warnings.push(line.slice(8));
	});
	let processError: Error | undefined;
	child.on("error", (error) => { processError = error; });
	// Ending stdin requests cleanup; do not abort SSH before its remote trap runs.
	child.stdin.on("error", () => {});
	let forced = false;
	let exited = false;
	let timer = setTimeout(() => { forced = true; child.kill("SIGTERM"); }, 1_320_000);
	const finish = (preserve: boolean) => {
		if (exited) return;
		clearTimeout(timer);
		if (!child.stdin.writableEnded) child.stdin.end(preserve ? "preserve\n" : "release\n");
		timer = setTimeout(() => { forced = true; child.kill("SIGTERM"); }, 45_000);
	};
	const abort = () => finish(false);
	signal.addEventListener("abort", abort, { once: true });
	const completion = new Promise<string[]>((resolve) => {
		child.on("close", (code) => {
			exited = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			lines.close();
			const error = processError ?? new Error(forced ? "MiniMax-H3 lifecycle cleanup timed out; check Sparkie."
				: diagnostic.trim() || `MiniMax-H3 lifecycle exited with code ${code}.`);
			if (!ready) rejectReady(error);
			if (forced || processError || code !== 0) warnings.push(error.message);
			resolve(warnings);
		});
	});
	if (signal.aborted) abort();
	try {
		await readiness;
		signal.throwIfAborted();
	} catch (error) {
		finish(false);
		await completion;
		throw error;
	}
	// Generation owns cancellation from here, so DELETE happens before shutdown.
	signal.removeEventListener("abort", abort);
	clearTimeout(timer);
	let released = false;
	return async (preserve) => {
		if (!released) { released = true; finish(preserve); }
		return completion;
	};
};
