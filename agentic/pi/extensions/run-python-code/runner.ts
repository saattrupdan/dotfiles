/** Multiline Python execution over a stdin-only protocol, locally or through SSH. */
import { spawn } from "node:child_process";
import { mkdtemp, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface PythonInput {
	code: string;
	ssh_alias?: string;
	cwd?: string;
	python?: string;
	timeout?: number;
}

export interface PythonResult {
	output: string;
	exitCode: number | null;
	outputPath: string;
	truncated: boolean;
}

// Keep stdin open after the JSON line: EOF means the caller/SSH connection went away.
// The supervisor and child use the same interpreter selected by uv, including its venv.
const SUPERVISOR = `import json, os, signal, subprocess, sys, threading
from pathlib import Path
from tempfile import TemporaryDirectory

request = json.loads(sys.stdin.buffer.readline())
with TemporaryDirectory(prefix="pi-python-") as directory:
    script = Path(directory) / "code.py"
    script.write_text(request["code"], encoding="utf-8")
    child = subprocess.Popen(
        [sys.executable, "-u", "-c",
         "import sys; from pathlib import Path; "
         "exec(compile(Path(sys.argv.pop()).read_text(encoding='utf-8'), "
         "'<run_python_code>', 'exec'))", str(script)], stdin=subprocess.DEVNULL,
        start_new_session=True,
    )

    def stop() -> None:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def disconnected() -> None:
        os.read(sys.stdin.fileno(), 1)
        stop()

    threading.Thread(target=disconnected, daemon=True).start()
    try:
        status = child.wait(timeout=request["timeout"])
    except subprocess.TimeoutExpired:
        stop()
        child.wait()
        sys.stderr.write("Python execution timed out.\\n")
        status = 124
    finally:
        stop()
    sys.exit(status if status >= 0 else 128 - status)
`;
const MAX_OUTPUT = 50 * 1024;

/** Execute without putting user source into a shell command or process arguments. */
export async function runPythonCode(
	input: PythonInput,
	cwd: string,
	signal?: AbortSignal,
): Promise<PythonResult> {
	if (typeof input.code !== "string" || !input.code.trim()) throw new Error("Python code must not be empty.");
	if (input.ssh_alias !== undefined && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(input.ssh_alias))
		throw new Error("ssh_alias must be an SSH config alias, not options or a command.");
	const timeout = input.timeout ?? 120;
	if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 86400)
		throw new Error("timeout must be between 0 and 86400 seconds (exclusive of 0).");
	const python = input.python ?? "python";
	if (!python || python.startsWith("-") || python.includes("\0")) throw new Error("python must be an executable name or path.");
	if (signal?.aborted) throw new Error("Python execution cancelled.");
	const args = ["run", "--", python, "-u", "-c", SUPERVISOR];
	const remote = input.ssh_alias !== undefined;
	const remoteCommand = `${input.cwd ? `cd ${quote(input.cwd)} && ` : ""}exec uv ${args.map(quote).join(" ")}`;
	const directory = await mkdtemp(path.join(tmpdir(), "pi-python-output-"));
	const outputPath = path.join(directory, "output.txt");
	const log = await open(outputPath, "w", 0o600);
	let tail = Buffer.alloc(0);
	let bytes = 0;
	let failure: string | undefined;
	try {
		return await new Promise<PythonResult>((resolve, reject) => {
			const child = spawn(remote ? "ssh" : "uv", remote
				? ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "--", input.ssh_alias!, remoteCommand]
				: args, {
				cwd: remote ? cwd : path.resolve(cwd, input.cwd ?? "."),
				detached: true,
				stdio: ["pipe", log.fd, log.fd],
			});
			const stdin = child.stdin!; // Explicitly piped above.
			// EOF reaches the supervisor before SSH is killed, so remote children stop too.
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const stop = (reason: string) => {
				if (failure) return;
				failure = reason;
				stdin.end();
				killTimer = setTimeout(() => {
					try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
				}, 1000);
			};
			const abort = () => stop("Python execution cancelled.");
			const timer = setTimeout(() => stop(`Python execution timed out after ${timeout} seconds.`), timeout * 1000);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			stdin.on("error", () => { /* Spawn/connection failure is reported by error or close. */ });
			child.once("error", (error) => { failure = error.message; });
			child.once("close", async (exitCode) => {
				clearTimeout(timer);
				if (killTimer) clearTimeout(killTimer);
				signal?.removeEventListener("abort", abort);
				stdin.destroy();
				try {
					const stats = await log.stat();
					bytes = stats.size;
					tail = Buffer.alloc(Math.min(bytes, MAX_OUTPUT));
					// Read the bounded tail through a separate descriptor; the writer is write-only.
					const reader = await open(outputPath, "r");
					try { await reader.read(tail, 0, tail.length, Math.max(0, bytes - tail.length)); }
					finally { await reader.close(); }
					const output = [tail.toString("utf8").split("\n").slice(-2000).join("\n"), failure].filter(Boolean).join("\n");
					resolve({ output, exitCode: failure ? (exitCode || 1) : exitCode, outputPath,
						truncated: bytes > MAX_OUTPUT || tail.toString("utf8").split("\n").length > 2000 });
				} catch (error) { reject(error); }
			});
			if (!failure) stdin.write(`${JSON.stringify({ code: input.code, timeout })}\n`);
		});
	} finally {
		await log.close();
	}
}

function quote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}
