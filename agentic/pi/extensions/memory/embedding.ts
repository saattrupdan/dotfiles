/** Local llama.cpp retrieval embeddings. No concept text is sent to a remote provider. */

export const MODEL = "jina-embeddings-v5-omni-small-retrieval";
export const DIMENSIONS = 1024;

export type EmbeddingSide = "query" | "document";
export type Embed = (text: string, side: EmbeddingSide) => Promise<number[]>;

export function createEmbedder(
	fetcher: typeof fetch = fetch,
	endpoint = "http://127.0.0.1:8080/v1/embeddings",
): Embed {
	return async (text, side) => {
		const response = await fetcher(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: MODEL, input: `${side === "query" ? "Query" : "Document"}: ${text}` }),
			signal: AbortSignal.timeout(60_000),
		});
		if (!response.ok) throw new Error(`llama.cpp embedding HTTP ${response.status}`);
		const payload: unknown = await response.json();
		const vector = (payload as { data?: Array<{ embedding?: unknown }> })?.data?.[0]?.embedding;
		if (!Array.isArray(vector) || vector.length !== DIMENSIONS ||
			vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
			throw new Error(`llama.cpp returned an invalid embedding (expected ${DIMENSIONS} dimensions)`);
		}
		return vector as number[];
	};
}
