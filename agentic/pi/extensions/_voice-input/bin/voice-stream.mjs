#!/usr/bin/env node
/**
 * Backend-neutral pseudo-streaming bridge for Pi voice input.
 *
 * Reads raw signed 16-bit mono 16 kHz PCM from stdin. Every configured interval
 * it submits all accumulated audio to the selected backend's ordinary batch
 * endpoint and emits a JSONL partial. At EOF it submits the complete clip and
 * emits a JSONL final.
 */

/* global AbortController, AbortSignal, Blob, FormData, fetch */

import { Buffer } from "node:buffer";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_MILLISECOND = (SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8)) / 1000;
const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 25_000;

function positiveNumber(value, fallback) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function pcmToWav(pcm) {
	const header = Buffer.alloc(44);
	const byteRate = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
	const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);

	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(CHANNELS, 22);
	header.writeUInt32LE(SAMPLE_RATE, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(blockAlign, 32);
	header.writeUInt16LE(BITS_PER_SAMPLE, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

export function resolveStreamConfig(env = process.env) {
	const backend = env.PI_PTT_BACKEND?.trim().toLowerCase() || "whisper";
	if (backend !== "whisper" && backend !== "syv") {
		throw new Error(`Unknown voice backend "${backend}".`);
	}
	return {
		backend,
		intervalBytes: Math.round(
			positiveNumber(env.PI_PTT_STREAM_INTERVAL_MS, DEFAULT_INTERVAL_MS) * BYTES_PER_MILLISECOND,
		),
		timeoutMs: positiveNumber(env.PI_PTT_STREAM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
		whisperUrl: (env.PI_PTT_WHISPER_SERVER_URL?.trim() || "http://127.0.0.1:8081").replace(/\/+$/, ""),
		syvApiKey: env.SYV_API_KEY?.trim() || "",
		syvBaseUrl: (env.PI_PTT_SYV_URL?.trim() || "https://platform.syv.ai/v1").replace(/\/+$/, ""),
		syvModel: env.PI_PTT_SYV_MODEL?.trim() || "syv-transcribe",
		language: env.PI_PTT_LANGUAGE?.trim() || "da",
	};
}

export async function transcribePcm(
	pcm,
	config,
	fetcher = fetch,
	signal = AbortSignal.timeout(config.timeoutMs),
) {
	if (pcm.length === 0) return "";
	if (config.backend === "syv" && !config.syvApiKey) {
		throw new Error("SYV_API_KEY is required for SYV streaming.");
	}

	const form = new FormData();
	form.append("file", new Blob([pcmToWav(pcm)], { type: "audio/wav" }), "audio.wav");
	form.append("response_format", "json");

	let url;
	const headers = {};
	if (config.backend === "syv") {
		url = `${config.syvBaseUrl}/audio/transcriptions`;
		headers.Authorization = `Bearer ${config.syvApiKey}`;
		form.append("model", config.syvModel);
		form.append("language", config.language);
		form.append("temperature", "0");
	} else {
		url = `${config.whisperUrl}/inference`;
		form.append("suppress_nst", "true");
	}

	const response = await fetcher(url, {
		method: "POST",
		headers,
		body: form,
		signal,
	});
	if (!response.ok) {
		const detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 300);
		throw new Error(`${config.backend} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
	}
	const payload = await response.json();
	if (typeof payload.text !== "string") {
		throw new Error(`${config.backend} response did not contain transcript text.`);
	}
	return payload.text.replace(/\s+/g, " ").trim();
}

function emit(type, text) {
	process.stdout.write(`${JSON.stringify({ type, text })}\n`);
}

function reportFailure(stage, error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`voice-stream: ${stage} failed: ${message}\n`);
}

export async function main() {
	const config = resolveStreamConfig();
	const chunks = [];
	let totalBytes = 0;
	let nextPartialAt = config.intervalBytes;
	let partialRequest = null;
	let partialController = null;

	for await (const chunk of process.stdin) {
		const buffered = Buffer.from(chunk);
		chunks.push(buffered);
		totalBytes += buffered.length;
		if (totalBytes < nextPartialAt) continue;
		while (nextPartialAt <= totalBytes) nextPartialAt += config.intervalBytes;
		if (partialRequest) continue;

		const snapshot = Buffer.concat(chunks, totalBytes);
		const controller = new AbortController();
		partialController = controller;
		partialRequest = transcribePcm(snapshot, config, fetch, controller.signal)
			.then((text) => {
				if (text) emit("partial", text);
			})
			.catch((error) => {
				if (!controller.signal.aborted) reportFailure("partial transcription", error);
			})
			.finally(() => {
				partialRequest = null;
				partialController = null;
			});
	}

	// A partial contains a stale prefix once stdin closes. Cancel it rather than
	// waiting (and potentially paying) before issuing the one authoritative final.
	if (partialController) partialController.abort();
	if (partialRequest) await partialRequest;

	const pcm = Buffer.concat(chunks, totalBytes);
	try {
		emit("final", await transcribePcm(pcm, config));
	} catch (error) {
		reportFailure("final transcription", error);
		process.exitCode = 1;
	}
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) await main();
