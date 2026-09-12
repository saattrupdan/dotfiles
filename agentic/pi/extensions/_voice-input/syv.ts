/** OpenAI-compatible syv-transcribe client for the voice-input extension. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

export type VoiceBackend = "whisper" | "syv";

export type SyvConfig = {
	apiKey: string;
	baseUrl: string;
	model: string;
	language: string;
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_BASE_URL = "https://platform.syv.ai/v1";
const DEFAULT_MODEL = "syv-transcribe";
const DEFAULT_LANGUAGE = "da";
const DEFAULT_ENV_FILE = path.join(os.homedir(), ".pi", "agent", "secrets", "voice-input.env");

/** Parse extension-specific settings locally; never add file secrets to global process.env. */
export function resolveVoiceInputEnv(
	env: NodeJS.ProcessEnv = process.env,
	envFile = env.PI_PTT_ENV_FILE?.trim() || DEFAULT_ENV_FILE,
): NodeJS.ProcessEnv {
	const fileEnv = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, "utf8")) : {};
	return { ...fileEnv, ...env };
}

export function parseVoiceBackend(value: string | undefined): VoiceBackend {
	const backend = value?.trim().toLowerCase() || "whisper";
	if (backend === "whisper" || backend === "syv") return backend;
	throw new Error(`Unknown voice backend "${value}". Use "whisper" or "syv".`);
}

export function resolveSyvConfig(env: NodeJS.ProcessEnv = process.env): SyvConfig {
	return {
		apiKey:
			env.SYV_API_KEY?.trim() ||
			env.PI_PTT_SYV_API_KEY?.trim() ||
			env.SYVAI_API_KEY?.trim() ||
			env.HVISKE_API_KEY?.trim() ||
			"",
		baseUrl: (env.PI_PTT_SYV_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
		model: env.PI_PTT_SYV_MODEL?.trim() || DEFAULT_MODEL,
		language: env.PI_PTT_LANGUAGE?.trim() || DEFAULT_LANGUAGE,
	};
}

export async function transcribeSyv(
	audioPath: string,
	config: SyvConfig = resolveSyvConfig(),
	fetcher: FetchLike = fetch,
): Promise<string> {
	if (!config.apiKey) {
		throw new Error(
			"syv-transcribe API key missing. Set SYV_API_KEY in ~/.pi/agent/secrets/voice-input.env or the shell environment.",
		);
	}

	const form = new FormData();
	form.append("file", new Blob([fs.readFileSync(audioPath)], { type: "audio/wav" }), "audio.wav");
	form.append("model", config.model);
	form.append("language", config.language);
	form.append("response_format", "json");
	form.append("temperature", "0");

	const response = await fetcher(`${config.baseUrl}/audio/transcriptions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${config.apiKey}` },
		body: form,
		signal: AbortSignal.timeout(120_000),
	});
	if (!response.ok) {
		const detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 300);
		throw new Error(
			`syv-transcribe returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
		);
	}

	const payload = (await response.json()) as { text?: unknown };
	if (typeof payload.text !== "string") {
		throw new Error("syv-transcribe response did not contain transcript text.");
	}
	return payload.text.replace(/\s+/g, " ").trim();
}
