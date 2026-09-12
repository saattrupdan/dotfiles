/* global Blob, FormData, Response */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

import { pcmToWav, resolveStreamConfig, transcribePcm } from "./bin/voice-stream.mjs";

const PCM = Buffer.alloc(32_000, 1);

test("pcmToWav wraps 16 kHz mono PCM in a valid WAV header", () => {
	const wav = pcmToWav(PCM);
	assert.equal(wav.toString("ascii", 0, 4), "RIFF");
	assert.equal(wav.toString("ascii", 8, 12), "WAVE");
	assert.equal(wav.readUInt16LE(22), 1);
	assert.equal(wav.readUInt32LE(24), 16_000);
	assert.equal(wav.readUInt16LE(34), 16);
	assert.equal(wav.readUInt32LE(40), PCM.length);
	assert.deepEqual(wav.subarray(44), PCM);
});

test("transcribePcm calls whisper-server's batch endpoint", async () => {
	const config = resolveStreamConfig({
		PI_PTT_BACKEND: "whisper",
		PI_PTT_WHISPER_SERVER_URL: "http://localhost:8081/",
	});
	const text = await transcribePcm(PCM, config, async (input, init) => {
		assert.equal(input, "http://localhost:8081/inference");
		assert.equal(init.method, "POST");
		assert.deepEqual(init.headers, {});
		assert.ok(init.body instanceof FormData);
		assert.equal(init.body.get("response_format"), "json");
		assert.equal(init.body.get("suppress_nst"), "true");
		assert.ok(init.body.get("file") instanceof Blob);
		return Response.json({ text: "  hej   fra whisper  " });
	});
	assert.equal(text, "hej fra whisper");
});

test("transcribePcm calls SYV's authenticated official batch endpoint", async () => {
	const config = resolveStreamConfig({
		PI_PTT_BACKEND: "syv",
		SYV_API_KEY: "hv_test",
		PI_PTT_SYV_URL: "https://platform.example/v1/",
		PI_PTT_SYV_MODEL: "syv-test",
		PI_PTT_LANGUAGE: "da",
	});
	const text = await transcribePcm(PCM, config, async (input, init) => {
		assert.equal(input, "https://platform.example/v1/audio/transcriptions");
		assert.equal(init.method, "POST");
		assert.equal(init.headers.Authorization, "Bearer hv_test");
		assert.ok(init.body instanceof FormData);
		assert.equal(init.body.get("model"), "syv-test");
		assert.equal(init.body.get("language"), "da");
		assert.equal(init.body.get("response_format"), "json");
		assert.equal(init.body.get("temperature"), "0");
		assert.ok(init.body.get("file") instanceof Blob);
		return Response.json({ text: "  hej   fra SYV  " });
	});
	assert.equal(text, "hej fra SYV");
});

test("transcribePcm refuses unauthenticated SYV requests", async () => {
	const config = resolveStreamConfig({ PI_PTT_BACKEND: "syv" });
	await assert.rejects(transcribePcm(PCM, config), /SYV_API_KEY/);
});

test("wrapper process emits authenticated SYV partial and final events", { timeout: 5_000 }, async () => {
	let requestCount = 0;
	const server = createServer((request, response) => {
		assert.equal(request.method, "POST");
		assert.equal(request.url, "/v1/audio/transcriptions");
		assert.equal(request.headers.authorization, "Bearer hv_process_test");
		request.resume();
		request.on("end", () => {
			requestCount += 1;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ text: `transcript ${requestCount}` }));
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");

	try {
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const wrapper = fileURLToPath(new URL("./bin/voice-stream.mjs", import.meta.url));
		const child = spawn(process.execPath, [wrapper], {
			env: {
				...process.env,
				PI_PTT_BACKEND: "syv",
				PI_PTT_STREAM_INTERVAL_MS: "10",
				PI_PTT_SYV_URL: `http://127.0.0.1:${address.port}/v1`,
				SYV_API_KEY: "hv_process_test",
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const partialSeen = new Promise((resolve) => {
			child.stdout.on("data", (chunk) => {
				stdout += chunk.toString();
				if (stdout.includes('"type":"partial"')) resolve();
			});
		});
		child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
		child.stdin.write(Buffer.alloc(640, 1));
		await partialSeen;
		child.stdin.end();
		const [exitCode] = await once(child, "close");

		assert.equal(exitCode, 0, stderr);
		assert.equal(requestCount, 2);
		assert.deepEqual(
			stdout.trim().split("\n").map((line) => JSON.parse(line)),
			[
				{ type: "partial", text: "transcript 1" },
				{ type: "final", text: "transcript 2" },
			],
		);
	} finally {
		server.close();
		await once(server, "close");
	}
});

test("wrapper cancels an in-flight partial before the SYV final request", { timeout: 5_000 }, async () => {
	let requestCount = 0;
	let markFirstRequestStarted;
	const firstRequestStarted = new Promise((resolve) => {
		markFirstRequestStarted = resolve;
	});
	const server = createServer((request, response) => {
		requestCount += 1;
		request.resume();
		if (requestCount === 1) {
			markFirstRequestStarted();
			return;
		}
		request.on("end", () => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ text: "complete final" }));
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");

	try {
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const wrapper = fileURLToPath(new URL("./bin/voice-stream.mjs", import.meta.url));
		const child = spawn(process.execPath, [wrapper], {
			env: {
				...process.env,
				PI_PTT_BACKEND: "syv",
				PI_PTT_STREAM_INTERVAL_MS: "10",
				PI_PTT_STREAM_TIMEOUT_MS: "1000",
				PI_PTT_SYV_URL: `http://127.0.0.1:${address.port}/v1`,
				SYV_API_KEY: "hv_process_test",
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
		child.stdin.write(Buffer.alloc(640, 1));
		await firstRequestStarted;
		child.stdin.end();
		const [exitCode] = await once(child, "close");

		assert.equal(exitCode, 0, stderr);
		assert.equal(requestCount, 2);
		assert.deepEqual(stdout.trim().split("\n").map((line) => JSON.parse(line)), [
			{ type: "final", text: "complete final" },
		]);
	} finally {
		server.closeAllConnections();
		server.close();
		await once(server, "close");
	}
});
