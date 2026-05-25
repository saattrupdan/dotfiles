/**
 * Orchestrator lockdown.
 *
 * The main agent is an orchestrator and has *no* permissions of its own —
 * only `subagent`, the user-facing `question` tool, and `skill` (so it can
 * load skill instructions by name without being granted general filesystem
 * read access). This extension:
 *
 *  1. Strips every other tool from the provider request payload before it
 *     is sent, so the LLM does not even *see* the tools it cannot use.
 *     This is far more token-efficient than letting it try and be blocked.
 *  2. As a belt-and-braces measure, also blocks any non-allowed tool call
 *     at the `tool_call` boundary, in case something slips through.
 *
 * Subagents are spawned in separate `pi` child processes (the subagent
 * extension sets `PI_SUBAGENT_CHILD=1` in their env) and opt out of both
 * mechanisms — they need full access to their declared tools.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ALLOWED = new Set([
	"subagent",
	"question",
	"skill",
	"memory_index",
	"memory_read",
	"memory_save",
	"memory_delete",
]);

/**
 * Walk a provider request payload and strip any `tools` array entries whose
 * tool name is not in ALLOWED. Handles both common shapes:
 *   - Anthropic-style:  { tools: [{ name, ... }, ...] }
 *   - OpenAI-style:     { tools: [{ type: "function", function: { name, ... } }, ...] }
 * The payload is provider-specific and otherwise opaque, so we mutate
 * defensively without assuming structure beyond the `tools` array.
 */
function stripTools(payload: unknown): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const obj = payload as Record<string, unknown>;
	const tools = obj.tools;
	if (Array.isArray(tools)) {
		obj.tools = tools.filter((t) => {
			if (!t || typeof t !== "object") return false;
			const tt = t as Record<string, unknown>;
			const fnObj = tt.function as Record<string, unknown> | undefined;
			const name =
				typeof tt.name === "string"
					? tt.name
					: typeof fnObj?.name === "string"
						? (fnObj.name as string)
						: undefined;
			return name !== undefined && ALLOWED.has(name);
		});
	}
	return obj;
}

export default function (pi: ExtensionAPI) {
	// Subagents run in their own pi child processes (spawned by the
	// `subagent` extension) and need full access to their declared tools.
	// The parent sets PI_SUBAGENT_CHILD=1 in the child env to opt out.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	pi.on("before_provider_request", async (event) => {
		return stripTools(event.payload);
	});

	pi.on("tool_call", async (event) => {
		if (!ALLOWED.has(event.toolName)) {
			return {
				block: true,
				reason:
					`Orchestrator is not permitted to call '${event.toolName}'. ` +
					`Delegate this work to a subagent instead (planner, builder, explorer, or reviewer).`,
			};
		}
	});
}
