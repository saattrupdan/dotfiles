/**
 * Task labels inherited by child subagents.
 *
 * A child pi process must not invent its own conversation name: the naming path
 * in extensions/conversation-name shells out to a nested `pi -p` and, on
 * failure, mechanically parses a multi-KB task prompt. Both are pointless for a
 * child, so the parent names it from the call's short task name, with a label of
 * the form
 *
 *     <agentName><ordinal>: <taskName>   e.g. "builder2: Fix parser"
 *
 * The label travels to the child in `PI_SUBAGENT_SESSION_NAME` (see index.ts)
 * and is applied there by extensions/conversation-name.
 */

/** JSON Schema pattern for a required, single-line 1–5-word task name. */
export const SUBAGENT_TASK_NAME_PATTERN = String.raw`^(?![\s\S]*[\x00-\x1F\x7F-\x9F])\S+(?: \S+){0,4}$`;

/** Make task names safe when rendering data that bypassed schema validation. */
export function normalizeSubagentTaskName(taskName: string): string {
	const withoutControls = Array.from(taskName, (character) => {
		const code = character.charCodeAt(0);
		return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : character;
	}).join("");
	return withoutControls.trim().split(/\s+/).filter(Boolean).slice(0, 5).join(" ");
}

/** Per-agent spawn counter, scoped to the parent process. */
export interface SubagentLabelCounter {
	/**
	 * Return the label for the next spawn of `agentName`, e.g.
	 * `builder2: Fix parser` for the second builder. Ordinals are handed out
	 * synchronously, so parallel spawns always get distinct numbers.
	 */
	next(agentName: string, taskName: string): string;
}

/** Create a counter that counts spawns per agent name. */
export function createSubagentLabelCounter(): SubagentLabelCounter {
	const ordinals = new Map<string, number>();
	return {
		next(agentName: string, taskName: string): string {
			const ordinal = (ordinals.get(agentName) ?? 0) + 1;
			ordinals.set(agentName, ordinal);
			return formatSubagentSessionLabel(agentName, ordinal, taskName);
		},
	};
}

/** Format one inherited label: `builder2: Fix parser`. */
export function formatSubagentSessionLabel(agentName: string, ordinal: number, taskName: string): string {
	const prefix = `${agentName}${ordinal}`;
	const task = normalizeSubagentTaskName(taskName);
	return task ? `${prefix}: ${task}` : prefix;
}

/** Format the merge commit created when a worktree subagent finishes. */
export function formatSubagentMergeCommitMessage(agentName: string, taskName: string): string {
	return `Merge ${agentName}: ${normalizeSubagentTaskName(taskName)}`;
}
