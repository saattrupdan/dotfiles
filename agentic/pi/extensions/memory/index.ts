/** The librarian's only five tools. The bundle root is fixed to ~/memory. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { MemoryStore } from "./store.ts";

let store: MemoryStore | undefined;
function memory(): MemoryStore { return store ??= new MemoryStore(); }

function answer(result: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "search_concepts",
		label: "search_concepts",
		description: "Hybrid BM25 and embedding search over the private OKF bundle. Provide query for ranked snippets, " +
			"or path (e.g. /projects/example.md) to read that exact concept's complete frontmatter and body. " +
			"Query embeddings use local llama.cpp; on failure, search logs the error and returns BM25 results.",
		parameters: Type.Object({
			query: Type.Optional(Type.String()),
			path: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 25 })),
		}),
		async execute(_id, params) { return answer(await memory().search(params)); },
	});
	// Recall subprocesses get only the search tool; normal librarian sessions get all five.
	if (process.env.PI_MEMORY_RECALL_ONLY === "1") return;
	pi.registerTool({
		name: "create_concept",
		label: "create_concept",
		description: "Create a typed OKF Markdown concept at a bundle-relative .md path. Large bodies become a " +
			"parent and linked parts below the model's 32,768-token limit. Embedding failures are logged; " +
			"the concept remains searchable via BM25 and lint_concepts reports missing embeddings.",
		parameters: Type.Object({
			path: Type.String(), type: Type.String(), body: Type.String(),
			title: Type.Optional(Type.String()), description: Type.Optional(Type.String()),
			tags: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params) { return answer(await memory().create(params)); },
	});
	pi.registerTool({
		name: "update_concept",
		label: "update_concept",
		description: "Replace an existing concept's body (and optionally metadata), preserving other frontmatter. " +
			"Re-embeds it and any generated parts; report missingEmbeddings if local embedding fails. " +
			"Use search_concepts with path first to inspect the concept.",
		parameters: Type.Object({
			path: Type.String(), body: Type.String(),
			type: Type.Optional(Type.String()), title: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()), tags: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params) { return answer(await memory().update(params)); },
	});
	pi.registerTool({
		name: "remove_concept",
		label: "remove_concept",
		description: "Delete a concept and its embedding. Removing a split parent also deletes its generated parts and embeddings.",
		parameters: Type.Object({ path: Type.String() }),
		async execute(_id, { path }) { return answer(await memory().remove(path)); },
	});
	pi.registerTool({
		name: "lint_concepts",
		label: "lint_concepts",
		description: "List malformed or oversized concepts, orphan concepts, broken relative or bundle-root links, " +
			"duplicate paragraphs, orphan embeddings, and missing or stale embeddings.",
		parameters: Type.Object({}),
		async execute() { return answer({ issues: memory().lint() }); },
	});
}
