/**
 * Inject `thinking.token_budget` into vLLM requests.
 *
 * Reads `thinkingTokenBudget` directly from models.json for the current model,
 * then injects `thinking: { token_budget: <value> }` into the request payload.
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
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (!model) return;

		const models = readModelsJson();
		if (!models) return;

		const budget = getThinkingTokenBudgetForModel(models, model.provider, model.id);
		if (budget === undefined || budget === null) return;

		const payload = event.payload as Record<string, unknown>;
		payload.thinking_token_budget = budget;
	});
}
