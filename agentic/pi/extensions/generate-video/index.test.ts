import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerVideo from "./index.ts";
import { generateVideo, type VideoInput } from "./video.ts";
import thinkingStatus from "../thinking-status/index.ts";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
const mp4 = Buffer.from([0, 0, 0, 24, ...Buffer.from("ftypisom"), 0, 0, 0, 0]);
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const job = (status: string, extra = {}) => json({ id: "video_test", status, ...extra });

function setup() {
	let tool: Tool | undefined;
	const working: (string | undefined)[] = [];
	registerVideo({ registerTool: (value: Tool) => { tool = value; } } as ExtensionAPI);
	assert.ok(tool);
	const ctx = { ui: { setWorkingMessage: (label?: string) => working.push(label) } } as ExtensionContext;
	return { tool, ctx, working };
}

test("submits multipart H3 settings, polls and downloads one local MP4", async () => {
	const requests: string[] = [];
	const phases: string[] = [];
	const replies = [job("queued"), job("in_progress", { progress: 42 }), job("completed"), new Response(mp4)];
	const output = await generateVideo({ prompt: "A cat meows", seed: 0 }, {
		endpoint: "http://router/", pollMs: 0, onProgress: (label) => phases.push(label),
		fetch: async (url, init) => {
			requests.push(`${init?.method ?? "GET"} ${url}`);
			if (init?.method === "POST") {
				assert.ok(init.body instanceof FormData);
				assert.deepEqual(Object.fromEntries(init.body.entries()), {
					model: "MiniMaxAI/MiniMax-H3", prompt: "A cat meows", seed: "0", seconds: "5",
					size: "1024x576", aspect_ratio: "16:9", fps: "24", num_inference_steps: "50", flow_shift: "12",
					extra_params: JSON.stringify({ task: "t2va", duration: 5, audio_flow_shift: 3 }),
				});
			}
			return replies.shift()!;
		},
	});
	try {
		assert.equal(output.jobId, "video_test");
		assert.equal(path.basename(output.path), "video.mp4");
		assert.deepEqual(await readFile(output.path), mp4);
		assert.deepEqual(requests, ["POST http://router/v1/videos", "GET http://router/v1/videos/video_test", "GET http://router/v1/videos/video_test", "GET http://router/v1/videos/video_test/content"]);
		assert.deepEqual(phases, ["Submitting video to Sparkie...", "Video queued on Sparkie...", "Generating video (42%)...", "Downloading video..."]);
	} finally {
		await rm(path.dirname(output.path), { recursive: true, force: true });
	}
});

test("portrait and square settings use bounded sizes and omit an unspecified seed", async () => {
	for (const [aspect_ratio, size] of [["9:16", "576x1024"], ["1:1", "768x768"]] as const) {
		const output = await generateVideo({ prompt: "Ocean waves", aspect_ratio, seconds: 10, steps: 2 }, {
			fetch: async (_url, init) => {
				if (init?.method === "POST") {
					const form = init.body as FormData;
					assert.equal(form.get("size"), size);
					assert.equal(form.get("aspect_ratio"), aspect_ratio);
					assert.equal(form.get("seconds"), "10");
					assert.equal(form.get("num_inference_steps"), "2");
					assert.equal(form.has("seed"), false);
					assert.equal(JSON.parse(form.get("extra_params") as string).duration, 10);
					return job("completed");
				}
				return new Response(mp4);
			},
		});
		await rm(path.dirname(output.path), { recursive: true, force: true });
	}
});

test("rejects invalid inputs before making a request", async () => {
	const invalid = [
		{ prompt: " " }, ...[0, 11, 1.5, NaN].map((seconds) => ({ seconds })),
		...[0, 51, 2.5].map((steps) => ({ steps })),
		...[-1, 2 ** 32, 1.5].map((seed) => ({ seed })), { aspect_ratio: "4:3" },
	];
	for (const input of invalid) {
		await assert.rejects(generateVideo({ prompt: "A cat", ...input } as VideoInput, {
			fetch: async () => { assert.fail("must not submit"); },
		}));
	}
});

test("pre-aborted calls never submit", async () => {
	await assert.rejects(generateVideo({ prompt: "A cat" }, {
		signal: AbortSignal.abort(), fetch: async () => { assert.fail("must not submit"); },
	}), /cancelled/);
});

test("HTTP submission errors include the router's reason", async () => {
	await assert.rejects(generateVideo({ prompt: "A cat" }, {
		fetch: async () => new Response("backend unavailable", { status: 503 }),
	}), /HTTP 503: backend unavailable/);
});

test("failed jobs preserve the model error and job ID without downloading", async () => {
	let calls = 0;
	await assert.rejects(generateVideo({ prompt: "A cat" }, {
		fetch: async () => { calls++; return job("failed", { error: { message: "Not enough memory" } }); },
	}), /Not enough memory.*video_test/);
	assert.equal(calls, 1);
});

test("invalid job metadata and mismatched polling IDs are rejected", async () => {
	for (const value of [null, {}, { id: "x", status: "unknown" }, { id: "", status: "queued" }]) {
		await assert.rejects(generateVideo({ prompt: "A cat" }, { fetch: async () => json(value) }), /invalid video job/);
	}
	let calls = 0;
	await assert.rejects(generateVideo({ prompt: "A cat" }, {
		pollMs: 0, fetch: async () => ++calls === 1 ? job("queued") : json({ id: "other", status: "completed" }),
	}), /different video job ID/);
});

test("bad downloads fail with a recoverable job ID and URL", async () => {
	for (const response of [new Response("not video"), new Response("missing", { status: 404 })]) {
		await assert.rejects(generateVideo({ prompt: "A cat" }, {
			endpoint: "http://router", fetch: async (_url, init) => init?.method === "POST" ? job("completed") : response,
		}), /Job: video_test.*http:\/\/router\/v1\/videos\/video_test/);
	}
});

test("aborting polling deletes the remote job with a fresh signal", async () => {
	const controller = new AbortController();
	let deleted = false;
	await assert.rejects(generateVideo({ prompt: "A cat" }, {
		signal: controller.signal,
		onProgress: (phase) => { if (phase.includes("queued")) controller.abort(); },
		fetch: async (url, init) => {
			if (init?.method === "DELETE") {
				assert.ok(String(url).endsWith("/video_test"));
				assert.equal(init.signal?.aborted, false);
				deleted = true;
				return json({ deleted: true });
			}
			return job("queued");
		},
	}), /cancelled.*Remote job deleted/);
	assert.equal(deleted, true);
});

test("aborts during submission still recover the ID and delete the accepted job", async () => {
	for (const phase of ["headers", "body"]) {
		const controller = new AbortController();
		const requests: string[] = [];
		await assert.rejects(generateVideo({ prompt: "A cat" }, {
			signal: controller.signal,
			fetch: async (_url, init) => {
				requests.push(init?.method ?? "GET");
				assert.equal(init?.signal?.aborted, false);
				if (init?.method === "DELETE") return json({ deleted: true });
				const response = job("queued");
				if (phase === "headers") controller.abort();
				else {
					response.json = async () => {
						controller.abort();
						assert.equal(init?.signal?.aborted, false);
						return { id: "video_test", status: "queued" };
					};
				}
				return response;
			},
		}), /cancelled.*Remote job deleted/);
		assert.deepEqual(requests, ["POST", "DELETE"]);
	}
});

test("unknown submission outcomes direct callers to inspect jobs before retrying", async () => {
	await assert.rejects(generateVideo({ prompt: "A cat" }, {
		endpoint: "http://router",
		fetch: async () => { throw new Error("connection lost"); },
	}), /connection lost.*No job ID received; check http:\/\/router\/v1\/videos before retrying/);
});

test("timeouts cancel remote jobs and cancellation failures remain visible", async () => {
	for (const fails of [false, true]) {
		let deletes = 0;
		await assert.rejects(generateVideo({ prompt: "A cat" }, {
			timeoutMs: 10, pollMs: 100,
			fetch: async (_url, init) => {
				if (init?.method === "DELETE") {
					deletes++;
					return fails ? new Response("still cancelling", { status: 409 }) : json({ deleted: true });
				}
				return job("queued");
			},
		}), fails ? /timed out.*Remote cancellation failed.*409/ : /timed out.*Remote job deleted/);
		assert.equal(deletes, 1);
	}
});

test("tool emits a partial result and returns a file URL without a message", async () => {
	const state = setup();
	const previous = globalThis.fetch;
	const updates: unknown[] = [];
	globalThis.fetch = async (_url, init) => init?.method === "POST" ? job("completed") : new Response(mp4);
	try {
		const result = await state.tool.execute("v1", { prompt: "A cat", steps: 2 }, undefined, (update) => updates.push(update), state.ctx);
		assert.equal(result.isError, undefined);
		assert.deepEqual(updates, [{ content: [], details: undefined }]);
		assert.match(JSON.stringify(result.content), /file:\/\/\/.*pi-video-.*video.mp4/);
		assert.deepEqual(state.working, ["Submitting video to Sparkie...", "Downloading video..."]);
		await rm(path.dirname((result.details as { path: string }).path), { recursive: true, force: true });
	} finally {
		globalThis.fetch = previous;
	}
});

test("tool prevents overlapping jobs, reports failures and unlocks afterward", async () => {
	const state = setup();
	const previous = globalThis.fetch;
	let finish: (value: Response) => void = () => {};
	globalThis.fetch = () => new Promise((resolve) => { finish = resolve; });
	try {
		const first = state.tool.execute("v1", { prompt: "A cat" }, undefined, undefined, state.ctx);
		const second = await state.tool.execute("v2", { prompt: "A cat" }, undefined, undefined, state.ctx);
		assert.equal(second.isError, true);
		assert.match(JSON.stringify(second.content), /already being generated/);
		finish(new Response("offline", { status: 503 }));
		assert.equal((await first).isError, true);
		const third = await state.tool.execute("v3", { prompt: " " }, undefined, undefined, state.ctx);
		assert.match(JSON.stringify(third.content), /must not be empty/);
	} finally {
		globalThis.fetch = previous;
	}
});

test("tool renderer has concise progress, success and failure states", () => {
	const { tool } = setup();
	const theme = { fg: (color: string, text: string) => `[${color}]${text}`, bold: (text: string) => text };
	const render = (expanded: boolean, isPartial: boolean, isError = false) =>
		tool.renderResult!({ content: [{ type: "text", text: "Full video result" }], details: undefined },
			{ expanded, isPartial }, theme as never, { isError } as never).render(120).join("\n").trimEnd();
	assert.equal(render(false, true), "[warning]⋯ Generating video");
	assert.equal(render(false, false), "[success]✓ Generated video");
	assert.equal(render(false, false, true), "[error]✗ video generation failed");
	assert.equal(render(true, false, true), "Full video result");
});

test("working indicator recognises generate_video", () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	thinkingStatus({ on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler), events: { on: () => {} } } as unknown as ExtensionAPI);
	const { ctx, working } = setup();
	handlers.get("tool_execution_start")!({ toolName: "generate_video", toolCallId: "v1" }, ctx);
	assert.deepEqual(working, ["Generating video..."]);
});
