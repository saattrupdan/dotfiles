/** The librarian's private concept tools. The bundle root is fixed to ~/memory. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { fingerprintBundle } from "./fingerprint.mjs";
import { MemoryStore } from "./store.ts";

let store: MemoryStore | undefined;
function memory(): MemoryStore { return store ??= new MemoryStore(); }

function answer(result: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
}

export default function (pi: ExtensionAPI, getStore: () => MemoryStore = memory): void {
	pi.registerTool({
		name: "search_concepts",
		label: "search_concepts",
		description: "Hybrid BM25 and embedding search over the private OKF bundle. Provide query for ranked snippets; " +
			"use read_concept for an exact slash-prefixed bundle path (e.g. /area/concept.md). The legacy path argument still reads a complete concept. " +
			"Query embeddings use local llama.cpp; on failure, search logs the error and returns BM25 results.",
		parameters: Type.Object({
			query: Type.Optional(Type.String()),
			path: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 25 })),
		}),
		async execute(_id, params) { return answer(await getStore().search(params)); },
	});
	pi.registerTool({
		name: "read_concept",
		label: "read_concept",
		description: "Read the complete frontmatter and body by exact slash-prefixed bundle path, e.g. /area/concept.md. Do not use relative or filesystem paths.",
		parameters: Type.Object({ path: Type.String() }),
		async execute(_id, { path }) { return answer(await getStore().search({ path })); },
	});
	// Recall runs can search and read; scheduled cleaning cannot create new concepts.
	if (process.env.PI_MEMORY_RECALL_ONLY === "1") return;
	const cleaning = process.env.PI_MEMORY_CLEANING_ONLY === "1";
	if (!cleaning) pi.registerTool({
		name: "create_concept",
		label: "create_concept",
		description: "Create a typed OKF Markdown concept at a slash-prefixed bundle path (e.g. /area/concept.md). Large bodies become a " +
			"parent and linked parts below the model's 32,768-token limit. Embedding failures are logged; " +
			"the concept remains searchable via BM25 and lint_concepts reports missing embeddings.",
		parameters: Type.Object({
			path: Type.String(), type: Type.String(), body: Type.String(),
			title: Type.Optional(Type.String()), description: Type.Optional(Type.String()),
			tags: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params) { return answer(await getStore().create(params)); },
	});
	pi.registerTool({
		name: "update_concept",
		label: "update_concept",
		description: "Replace an existing concept's body (and optionally metadata), preserving other frontmatter. " +
			"Re-embeds it and any generated parts; report missingEmbeddings if local embedding fails. " +
			"Use read_concept first to inspect the concept; path must be slash-prefixed and bundle-rooted.",
		parameters: Type.Object({
			path: Type.String(), body: Type.String(),
			type: Type.Optional(Type.String()), title: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()), tags: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params) { return answer(await getStore().update(params)); },
	});
	pi.registerTool({
		name: "remove_concept",
		label: "remove_concept",
		description: "Archive the complete concept and its generated parts in ~/memory/requests/removed before " +
			"removing them from active search, along with their embeddings. Scheduled cleanup permits removal " +
			"only of an unlinked exact duplicate. Provide a slash-prefixed bundle path; returns the archive path.",
		parameters: Type.Object({ path: Type.String() }),
		async execute(_id, { path }) { return answer(await getStore().remove(path, cleaning)); },
	});
	if (cleaning) pi.registerTool({
		name: "repair_malformed",
		label: "repair_malformed",
		description: "Archive malformed concept files byte-for-byte, then wrap their original content in a valid Note " +
			"without discarding any text. Re-embeds recovered files and reports failures.",
		parameters: Type.Object({}),
		async execute() { return answer(await getStore().repairMalformed()); },
	});
	if (cleaning) pi.registerTool({
		name: "repair_orphans",
		label: "repair_orphans",
		description: "Create or refresh a navigational catalog linking all stored concepts and link it from a concept. " +
			"Resolves orphan lint findings without deleting concepts or inventing facts; archives prior versions.",
		parameters: Type.Object({}),
		async execute() { return answer(await getStore().repairOrphans()); },
	});
	if (cleaning) pi.registerTool({
		name: "repair_embeddings",
		label: "repair_embeddings",
		description: "Restore missing or stale concept vectors and prune vectors only when their Markdown is truly absent. " +
			"Archives corrupt vector snapshots before rebuilding from Markdown; preserves concept text " +
			"and reports embedding failures for automatic retry.",
		parameters: Type.Object({}),
		async execute() { return answer(await getStore().repairEmbeddings()); },
	});
	pi.registerTool({
		name: "lint_concepts",
		label: "lint_concepts",
		description: "List malformed or oversized concepts, orphan concepts, broken relative or bundle-root links, " +
			"duplicate paragraphs, orphan embeddings, and missing or stale embeddings.",
		parameters: Type.Object({}),
		async execute() {
			const store = getStore();
			const before = fingerprintBundle(store.root);
			const issues = store.lint();
			const after = fingerprintBundle(store.root);
			return answer({ issues, fingerprint: before === after ? after : null });
		},
	});
}
