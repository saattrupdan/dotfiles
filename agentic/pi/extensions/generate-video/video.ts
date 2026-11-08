/** MiniMax-H3 job lifecycle: submit, poll, cancel and download behind one interface. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export interface VideoInput {
	prompt: string;
	seconds?: number;
	aspect_ratio?: "16:9" | "9:16" | "1:1";
	steps?: number;
	seed?: number;
}

interface VideoJob {
	id: string;
	status: "queued" | "in_progress" | "completed" | "failed";
	progress?: number;
	error?: { message?: string } | null;
}

interface VideoOptions {
	signal?: AbortSignal;
	onProgress?: (label: string) => void;
	endpoint?: string;
	fetch?: typeof fetch;
	pollMs?: number;
	timeoutMs?: number;
}

const SIZES = { "16:9": "1024x576", "9:16": "576x1024", "1:1": "768x768" };
const MODEL = "MiniMaxAI/MiniMax-H3";

function parseJob(value: unknown): VideoJob {
	const job = value as Partial<VideoJob> | null;
	if (!job || typeof job.id !== "string" || !job.id.trim() ||
		!["queued", "in_progress", "completed", "failed"].includes(job.status ?? "")) {
		throw new Error("Router returned invalid video job metadata.");
	}
	return job as VideoJob;
}

async function checked(response: Response): Promise<Response> {
	if (!response.ok) {
		const detail = (await response.text()).slice(0, 2000);
		throw new Error(`Video router HTTP ${response.status}: ${detail || response.statusText}`);
	}
	return response;
}

export async function generateVideo(input: VideoInput, options: VideoOptions = {}): Promise<{ path: string; jobId: string }> {
	const seconds = input.seconds ?? 5;
	const steps = input.steps ?? 50;
	const aspect = input.aspect_ratio ?? "16:9";
	if (!input.prompt.trim()) throw new Error("Video prompt must not be empty.");
	if (!Number.isInteger(seconds) || seconds < 1 || seconds > 10) throw new Error("seconds must be an integer from 1 to 10.");
	if (!Number.isInteger(steps) || steps < 1 || steps > 50) throw new Error("steps must be an integer from 1 to 50.");
	if (!Object.hasOwn(SIZES, aspect)) throw new Error("aspect_ratio must be 16:9, 9:16 or 1:1.");
	if (input.seed !== undefined && (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 2 ** 32 - 1)) {
		throw new Error("seed must be an integer from 0 to 4294967295.");
	}

	const request = options.fetch ?? fetch;
	const base = (options.endpoint ?? process.env.MINIMAX_VIDEO_URL ?? "http://100.102.237.34:31000").replace(/\/+$/, "");
	const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(options.timeoutMs ?? 3_600_000)]);
	const form = new FormData();
	for (const [key, value] of Object.entries({
		model: MODEL, prompt: input.prompt, seconds, size: SIZES[aspect], aspect_ratio: aspect,
		fps: 24, num_inference_steps: steps, flow_shift: 12,
		extra_params: JSON.stringify({ task: "t2va", duration: seconds, audio_flow_shift: 3 }),
	})) form.set(key, String(value));
	if (input.seed !== undefined) form.set("seed", String(input.seed));

	let jobId: string | undefined;
	let directory: string | undefined;
	let submitting = false;
	try {
		signal.throwIfAborted();
		options.onProgress?.("Submitting video to Sparkie...");
		// Recover the ID even if the caller aborts after the router accepts the POST.
		// This signal covers both response headers and the JSON body, but is independent
		// of caller cancellation so we can DELETE the accepted job afterward.
		submitting = true;
		const submissionSignal = AbortSignal.timeout(30_000);
		const submission = await request(`${base}/v1/videos`, { method: "POST", body: form, signal: submissionSignal });
		if (!submission.ok) submitting = false;
		let job = parseJob(await (await checked(submission)).json());
		jobId = job.id;
		submitting = false;
		signal.throwIfAborted();
		const jobUrl = `${base}/v1/videos/${encodeURIComponent(jobId)}`;
		while (job.status !== "completed") {
			if (job.status === "failed") throw new Error(job.error?.message || "Video generation failed.");
			const progress = typeof job.progress === "number" && Number.isFinite(job.progress)
				? ` (${Math.min(100, Math.max(0, job.progress))}%)` : "";
			options.onProgress?.(job.status === "queued" ? "Video queued on Sparkie..." : `Generating video${progress}...`);
			await sleep(options.pollMs ?? 3000, undefined, { signal });
			job = parseJob(await (await checked(await request(jobUrl, { signal }))).json());
			if (job.id !== jobId) throw new Error("Router returned a different video job ID.");
		}
		options.onProgress?.("Downloading video...");
		const response = await checked(await request(`${jobUrl}/content`, { signal }));
		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp") throw new Error("Router did not return an MP4 video.");
		signal.throwIfAborted();
		directory = await mkdtemp(path.join(os.tmpdir(), "pi-video-"));
		const output = path.join(directory, "video.mp4");
		await writeFile(output, bytes, { signal });
		return { path: output, jobId };
	} catch (error) {
		if (directory) await rm(directory, { recursive: true, force: true });
		let message = signal.aborted
			? (options.signal?.aborted ? "Video generation cancelled." : "Video generation timed out after one hour.")
			: error instanceof Error ? error.message : String(error);
		if (submitting) message += ` No job ID received; check ${base}/v1/videos before retrying. Submission outcome is unknown.`;
		if (jobId) {
			message += ` Job: ${jobId}.`;
			if (signal.aborted) {
				try {
					await checked(await request(`${base}/v1/videos/${encodeURIComponent(jobId)}`, { method: "DELETE", signal: AbortSignal.timeout(10_000) }));
					message += " Remote job deleted.";
				} catch (cancelError) {
					message += ` Remote cancellation failed: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`;
				}
			} else {
				message += ` Status/content: ${base}/v1/videos/${encodeURIComponent(jobId)}`;
			}
		}
		throw new Error(message, { cause: error });
	}
}
