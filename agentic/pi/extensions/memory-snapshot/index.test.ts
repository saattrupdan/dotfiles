import assert from "node:assert/strict";
import { test } from "node:test";

import { appendSnapshotToSystemPrompt, buildBeforeAgentStartResult } from "./index.ts";

test("native snapshot is injected only when a validated overview is present", () => {
	const event = { type: "before_agent_start", prompt: "hello", systemPrompt: "base prompt" };
	assert.equal(buildBeforeAgentStartResult(event as never, null), undefined);
	const result = buildBeforeAgentStartResult(event as never, "Concepts: 3. Use recall_memory.");
	assert.equal(result?.systemPrompt, "base prompt\n\nConcepts: 3. Use recall_memory.");
	assert.equal(appendSnapshotToSystemPrompt("system", "overview"), "system\n\noverview");
});
