/** Main-only memory bridge: the librarian runs with its own strict five-tool profile. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { runLibrarian } from "./runner.ts";

const Params = Type.Object({
	text: Type.String({ description: "The text to remember or the question to recall from the OKF bundle." }),
});

export default function (pi: ExtensionAPI): void {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;
	pi.registerTool({
		name: "store_memory",
		label: "store_memory",
		description: "Ask the isolated librarian to search the disposable ~/memory bundle and store this text " +
			"by creating or updating concepts. Returns changed bundle paths. " +
			"These test memories will be replaced when Understory is migrated.",
		parameters: Params,
		async execute(_id, { text }, signal) {
			const answer = await runLibrarian("store", text, signal);
			return { content: [{ type: "text", text: answer }], details: undefined };
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
