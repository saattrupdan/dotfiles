/** Main-only memory bridge: the librarian runs with its own strict five-tool profile. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { counts, enqueue, wake } from "./queue.mjs";
import { runLibrarian } from "./runner.ts";

const Params = Type.Object({
	text: Type.String({ description: "The text to remember or the question to recall from the OKF bundle." }),
});

export default function (pi: ExtensionAPI): void {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;
	pi.on("session_start", () => {
		try { wake(); } catch (error) { console.error(`[pi-memory] worker startup failed: ${String(error)}`); }
	});
	pi.registerTool({
		name: "store_memory",
		label: "store_memory",
		description: "Durably queue this text for the isolated librarian to create or update a concept. " +
			"Returns a job ID immediately, NOT confirmation that the memory was stored. " +
			"Failed requests remain in ~/memory/requests/failed for inspection and retry.",
		parameters: Params,
		async execute(_id, { text }) {
			const id = enqueue(text);
			try { wake(); } catch (error) { console.error(`[pi-memory] queued ${id}, worker launch failed: ${String(error)}`); }
			const state = counts();
			const outstanding = state.pending + state.running;
			return { content: [{ type: "text", text: `Queued memory request ${id}; ${outstanding} outstanding. This is not a storage confirmation.` }],
				details: { id, outstanding } };
		},
	});
	pi.registerTool({
		name: "recall_memory",
		label: "recall_memory",
		description: "Ask the isolated librarian to search and read concepts in ~/memory. " +
			"Returns a cited answer. This read-only handoff cannot register write tools.",
		parameters: Params,
		async execute(_id, { text }, signal) {
			const answer = await runLibrarian("recall", text, signal);
			return { content: [{ type: "text", text: answer }], details: undefined };
		},
	});
}
