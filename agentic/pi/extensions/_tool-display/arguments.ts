/** Bounded display copies; original tool arguments remain untouched. */
export function boundedToolArguments(input: unknown): { args: unknown; limited: boolean } {
	let remaining = 64 * 1024;
	let nodes = 10000;
	let limited = false;
	const identifying = new Set([
		"path",
		"file_path",
		"name",
		"agent",
		"taskName",
		"query",
		"command",
	]);
	function visit(value: unknown, depth: number): unknown {
		if (--nodes < 0 || depth >= 8) {
			limited = true;
			return "…";
		}
		if (typeof value === "string") {
			const kept = value
				.slice(0, remaining)
				.split("\n")
				.slice(0, 1000)
				.map((line) => line.slice(0, 2048))
				.join("\n");
			remaining -= kept.length;
			if (kept === value) return value;
			limited = true;
			return kept;
		}
		if (!value || typeof value !== "object") return value;
		if (Array.isArray(value)) {
			const result: unknown[] = [];
			for (const item of value) {
				if (result.length >= 200 || nodes <= 0) {
					limited = true;
					break;
				}
				result.push(visit(item, depth + 1));
			}
			return result;
		}
		const entries = Object.entries(value);
		const selected = entries
			.filter(([key]) => identifying.has(key))
			.concat(entries.filter(([key]) => !identifying.has(key)))
			.slice(0, 200);
		const values = new Map<string, unknown>();
		if (selected.length !== entries.length) limited = true;
		for (const [key, item] of selected) {
			if (nodes <= 0) {
				limited = true;
				break;
			}
			values.set(key, visit(item, depth + 1));
		}
		return Object.fromEntries(
			entries.filter(([key]) => values.has(key)).map(([key]) => [key, values.get(key)]),
		);
	}
	return { args: visit(input ?? {}, 0), limited };
}
