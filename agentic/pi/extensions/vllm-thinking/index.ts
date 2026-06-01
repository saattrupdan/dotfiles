/**
 * Inject `thinking_token_budget` into vLLM requests.
 *
 * Reads `thinkingTokenBudget` directly from models.json for the current model,
 * then injects the flat `thinking_token_budget: <value>` field into the request
 * payload (the field vLLM's OpenAI-compatible server recognizes).
 * Fully self-contained — no Pi core changes needed.
 *
 * Usage in models.json (top-level on the model, not inside compat):
 *   {
 *     "providers": {
 *       "llamacpp": {
 *         "baseUrl": "http://localhost:8080/v1",
 *         "api": "openai-completions",
 *         "models": [{
 *           "id": "qwen3.6-35B-A3B",
 *           "contextWindow": 262144,
 *           "thinkingTokenBudget": 2048
 *         }]
 *       }
 *     }
 *   }
 *
 * Per-session override (commands):
 *   /reasoning-budget <N> [prompt]  — set a sticky budget of N tokens for the rest
 *                                     of this session; if a prompt follows, submit it
 *                                     immediately. Overrides the models.json default.
 *   /reset-reasoning-budget         — clear the override; revert to the models.json
 *                                     default for this model.
 * The override is in-memory only: new sessions always start on the models.json default.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Sticky per-session budget override (tokens). null = use the models.json default. */
let sessionBudgetOverride: number | null = null;

const STATUS_KEY = "reasoningBudget";

function readModelsJson(): Record<string, unknown> | null {
	// Follow Pi's own path resolution: PI_CODING_AGENT_DIR env var, or ~/.pi/agent
	const agentDir =
		process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	const modelsPath = path.join(agentDir, "models.json");
	try {
		const content = fs.readFileSync(modelsPath, "utf-8");
		return JSON.parse(content) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function getThinkingTokenBudgetForModel(
	models: Record<string, unknown>,
	provider: string,
	modelId: string,
): number | undefined {
	const providers = models.providers as Record<string, unknown> | undefined;
	if (!providers) return undefined;

	const providerConfig = providers[provider] as Record<string, unknown> | undefined;
	if (!providerConfig) return undefined;

	const modelsArr = providerConfig.models as Array<Record<string, unknown>> | undefined;
	if (!modelsArr) return undefined;

	for (const m of modelsArr) {
		if (m.id === modelId && m.thinkingTokenBudget !== undefined) {
			return m.thinkingTokenBudget as number;
		}
	}
	return undefined;
}

function updateStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(
		STATUS_KEY,
		sessionBudgetOverride === null ? undefined : `🧠 ${sessionBudgetOverride}`,
	);
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (!model) return;

		let budget: number | undefined;
		if (sessionBudgetOverride !== null) {
			budget = sessionBudgetOverride;
		} else {
			const models = readModelsJson();
			if (!models) return;
			budget = getThinkingTokenBudgetForModel(models, model.provider, model.id);
		}
		if (budget === undefined || budget === null) return;

		const payload = event.payload as Record<string, unknown>;
		payload.thinking_token_budget = budget;
	});

	// New sessions always start on the models.json default.
	pi.on("session_start", (_event, ctx) => {
		sessionBudgetOverride = null;
		updateStatus(ctx);
	});

	pi.registerCommand("reasoning-budget", {
		description:
			"Set a sticky reasoning-token budget for this session: /reasoning-budget <N> [prompt]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				if (ctx.hasUI)
					ctx.ui.notify(
						"Usage: /reasoning-budget <N> [prompt] — N is a positive integer of thinking tokens.",
						"warning",
					);
				return;
			}

			const match = trimmed.match(/^(\d+)(?:\s+([\s\S]+))?$/);
			if (!match) {
				if (ctx.hasUI)
					ctx.ui.notify(
						`Invalid budget "${trimmed.split(/\s+/)[0]}" — expected a positive integer first, e.g. /reasoning-budget 16384`,
						"error",
					);
				return;
			}

			const budget = Number.parseInt(match[1], 10);
			const prompt = match[2]?.trim();

			sessionBudgetOverride = budget;
			updateStatus(ctx);
			if (ctx.hasUI)
				ctx.ui.notify(
					`Reasoning budget set to ${budget} tokens for this session.`,
					"info",
				);

			if (prompt) ctx.sendUserMessage(prompt);
		},
	});

	pi.registerCommand("reset-reasoning-budget", {
		description: "Clear the session reasoning-budget override; revert to the models.json default.",
		handler: async (_args, ctx) => {
			sessionBudgetOverride = null;
			updateStatus(ctx);
			if (ctx.hasUI)
				ctx.ui.notify("Reasoning budget reset to the model default.", "info");
		},
	});
}
