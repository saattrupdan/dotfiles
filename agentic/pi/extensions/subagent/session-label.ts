/**
 * Session labels inherited by child subagents.
 *
 * A child pi process must not invent its own conversation name: the naming path
 * in extensions/conversation-name shells out to a nested `pi -p` and, on
 * failure, mechanically parses a multi-KB task prompt. Both are pointless for a
 * child, so the parent names it instead, with a label of the form
 *
 *     <agentName><ordinal>: <parent session name>   e.g. "builder2: Fix the parser"
 *
 * The label travels to the child in `PI_SUBAGENT_SESSION_NAME` (see index.ts)
 * and is applied there by extensions/conversation-name.
 */

/** Per-agent spawn counter, scoped to the parent process. */
export interface SubagentLabelCounter {
	/**
	 * Return the label for the next spawn of `agentName`, e.g. `builder2` for
	 * the second builder. Ordinals are handed out synchronously, so parallel
	 * spawns in one parent process always get distinct numbers.
	 *
	 * Degrades to the bare `builder2` when the parent session has no name yet
	 * — never `builder2: undefined`.
	 */
	next(agentName: string, parentName: string | undefined): string;
}

/** Create a counter that counts spawns per agent name. */
export function createSubagentLabelCounter(): SubagentLabelCounter {
	const ordinals = new Map<string, number>();
	return {
		next(agentName: string, parentName: string | undefined): string {
			const ordinal = (ordinals.get(agentName) ?? 0) + 1;
			ordinals.set(agentName, ordinal);
			return formatSubagentSessionLabel(agentName, ordinal, parentName);
		},
	};
}

/** Format one inherited label: `builder2: <parent name>`, or `builder2` alone. */
export function formatSubagentSessionLabel(
	agentName: string,
	ordinal: number,
	parentName: string | undefined,
): string {
	const prefix = `${agentName}${ordinal}`;
	// Session names are single-line, but a pasted-in name must not smuggle a
	// newline into the child's environment or the parent's UI row.
	const parent = parentName?.replace(/\s+/g, " ").trim();
	return parent ? `${prefix}: ${parent}` : prefix;
}
