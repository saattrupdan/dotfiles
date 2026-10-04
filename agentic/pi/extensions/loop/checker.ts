/** A fresh, ephemeral Pi process evaluates the completion condition after each run. */

import { spawn } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPiInvocation } from "../subagent/pi-invocation.ts";

const TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT = 64_000;

export interface Verdict {
	done: boolean;
	evidence: string;
}

export function parseVerdict(text: string): Verdict {
	let value: unknown;
	try {
		value = JSON.parse(text.trim());
	} catch {
		throw new Error("Checker did not return JSON.");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Checker returned an invalid verdict.");
	}
	const result = value as Record<string, unknown>;
	if (typeof result.done !== "boolean" || typeof result.evidence !== "string" || !result.evidence.trim()) {
		throw new Error("Checker verdict needs a boolean done and nonempty evidence.");
	}
	return { done: result.done, evidence: result.evidence.trim() };
}

export async function checkCondition(
	condition: string,
	iterationOutput: string,
	ctx: ExtensionContext,
	signal: AbortSignal,
): Promise<Verdict> {
	const prompt = [
		"You are an independent completion checker for a periodic Pi task. Inspect the current working directory as needed.",
		"Use read and, only if verification needs it, bash for NON-MUTATING checks. Do not edit files, commit, delegate, or ask questions.",
		"Do not trust the working agent's claim of success: independently verify the condition. If evidence is insufficient, return done=false.",
		"Return ONLY a JSON object: {\"done\": boolean, \"evidence\": \"short concrete reason\"}. No Markdown.",
		`Completion condition:\n${condition}`,
		`Working agent's most recent final response (context, not proof):\n${iterationOutput.slice(-8_000)}`,
	].join("\n\n");
	const args = ["--mode", "text", "-p", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--tools", "read,bash"];
	if (ctx.model) args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
	args.push("--", prompt);
	const invocation = getPiInvocation(args);

	return new Promise<Verdict>((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Checker canceled."));
			return;
		}
		const grouped = process.platform !== "win32";
		const child = spawn(invocation.command, invocation.args, {
			cwd: ctx.cwd,
			env: { ...process.env, PI_NON_INTERACTIVE: "1" },
			stdio: ["ignore", "pipe", "pipe"],
			detached: grouped,
		});
		let stdout = "";
		let stderr = "";
		let exceeded = false;
		let timedOut = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const kill = (signalName: NodeJS.Signals) => {
			try {
				if (grouped && child.pid) process.kill(-child.pid, signalName);
				else child.kill(signalName);
			} catch { /* The child may already have exited. */ }
		};
		const terminate = () => {
			if (killTimer) return;
			kill("SIGTERM");
			killTimer = setTimeout(() => kill("SIGKILL"), 2_000);
		};
		const onAbort = () => terminate();
		const timeout = setTimeout(() => { timedOut = true; terminate(); }, TIMEOUT_MS);
		signal.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
			if (stdout.length > OUTPUT_LIMIT) { exceeded = true; terminate(); }
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr = (stderr + data.toString()).slice(-4_000);
		});
		const cleanup = () => {
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			signal.removeEventListener("abort", onAbort);
		};
		child.once("error", (error) => {
			cleanup();
			reject(error);
		});
		child.once("close", (code) => {
			cleanup();
			if (signal.aborted) reject(new Error("Checker canceled."));
			else if (timedOut) reject(new Error("Checker timed out."));
			else if (exceeded) reject(new Error("Checker output exceeded limit."));
			else if (code !== 0) reject(new Error(`Checker exited ${code}: ${stderr.slice(-500)}`));
			else {
				try { resolve(parseVerdict(stdout)); } catch (error) { reject(error); }
			}
		});
	});
}
