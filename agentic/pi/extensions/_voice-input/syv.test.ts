import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseVoiceBackend, resolveSyvConfig, resolveVoiceInputEnv, transcribeSyv } from "./syv.ts";

test("parseVoiceBackend defaults to whisper and accepts syv", () => {
	assert.equal(parseVoiceBackend(undefined), "whisper");
	assert.equal(parseVoiceBackend(" SYV "), "syv");
	assert.throws(() => parseVoiceBackend("other"), /Unknown voice backend/);
});

test("resolveVoiceInputEnv keeps file secrets local and lets shell values win", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-syv-env-test-"));
	const envPath = path.join(dir, "voice-input.env");
	const marker = "PI_VOICE_TEST_FILE_ONLY";
	fs.writeFileSync(envPath, `${marker}=private\nSYV_API_KEY=hv_file\nPI_PTT_BACKEND=syv\n`);
	delete process.env[marker];

	try {
		const resolved = resolveVoiceInputEnv({ SYV_API_KEY: "hv_shell" }, envPath);
		assert.equal(resolved[marker], "private");
		assert.equal(resolved.SYV_API_KEY, "hv_shell");
		assert.equal(resolved.PI_PTT_BACKEND, "syv");
		assert.equal(process.env[marker], undefined);
	} finally {
		delete process.env[marker];
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveSyvConfig prefers SYV_API_KEY and trims the endpoint", () => {
	assert.deepEqual(
		resolveSyvConfig({
			SYV_API_KEY: " hv_primary ",
			PI_PTT_SYV_API_KEY: "hv_fallback",
			PI_PTT_SYV_URL: "https://example.test/v1/",
			PI_PTT_SYV_MODEL: "custom-model",
			PI_PTT_LANGUAGE: "en",
		}),
		{
			apiKey: "hv_primary",
			baseUrl: "https://example.test/v1",
			model: "custom-model",
			language: "en",
		},
	);
});

test("transcribeSyv sends an OpenAI-compatible multipart request", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-syv-test-"));
	const audioPath = path.join(dir, "audio.wav");
	fs.writeFileSync(audioPath, Buffer.from("wav-data"));

	try {
		const text = await transcribeSyv(
			audioPath,
			{
				apiKey: "hv_test",
				baseUrl: "https://platform.example/v1",
				model: "syv-transcribe",
				language: "da",
			},
			async (input, init) => {
				assert.equal(input, "https://platform.example/v1/audio/transcriptions");
				assert.equal(init?.method, "POST");
				assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer hv_test");
				assert.ok(init?.body instanceof FormData);
				assert.equal(init.body.get("model"), "syv-transcribe");
				assert.equal(init.body.get("language"), "da");
				assert.equal(init.body.get("response_format"), "json");
				assert.equal(init.body.get("temperature"), "0");
				assert.ok(init.body.get("file") instanceof Blob);
				return Response.json({ text: "  hej   verden  " });
			},
		);
		assert.equal(text, "hej verden");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("transcribeSyv fails before making a request when the key is absent", async () => {
	await assert.rejects(
		transcribeSyv("unused.wav", {
			apiKey: "",
			baseUrl: "https://platform.syv.ai/v1",
			model: "syv-transcribe",
			language: "da",
		}),
		/SYV_API_KEY/,
	);
});
