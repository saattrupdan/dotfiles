/** Shared laptop/Remote working labels and phase precedence; no runtime side effects. */
const TOOL_LABELS: Record<string, string> = {
	// built-in tools
	read: "Reading...",
	write: "Writing...",
	edit: "Editing...",
	bash: "Bashing...",
	run_python_code: "Handling the Python...",
	// extension tools
	search: "Searching...",
	code_tree: "Mapping...",
	generate_image: "Generating image...",
	generate_video: "Generating video...",
	skill: "Upskilling...",
	question: "Questioning...",
	web_browse: "Browsing...",
	web_search: "Searching...",
	subagent: "Whipping the subagents...",
	store_memory: "Storing to memory…",
	recall_memory: "Recalling from memory…",
	read_concept: "Reading concept…",
	isolated_new_branch: "Creating branch...",
	discard_isolated_branch: "Discarding branch...",
	clean_up_isolated_branch: "Cleaning up branch...",
};

export class WorkingStatus {
	private streamLabel: string | undefined;
	private overrideLabel: string | undefined;
	private tools = new Map<string, string>();
	get label(): string | undefined {
		return this.overrideLabel ?? [...this.tools.values()].at(-1) ?? this.streamLabel;
	}
	message(active: boolean): string | undefined {
		return active || this.overrideLabel !== undefined ? (this.label ?? "Working...") : undefined;
	}
	update(kind: string, value: unknown): boolean {
		const before = this.label;
		const data = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
		if (kind === "message_update") {
			const blocks = Array.isArray(data.content) ? data.content : [];
			const last = blocks.at(-1);
			this.streamLabel =
				last?.type === "thinking"
					? "Thinking..."
					: last?.type === "toolCall"
						? TOOL_LABELS[last.name]
						: undefined;
		} else if (kind === "tool_execution_start") {
			const name = typeof data.name === "string" ? data.name : data.toolName;
			if (typeof data.toolCallId === "string" && typeof name === "string" && TOOL_LABELS[name])
				this.tools.set(data.toolCallId, TOOL_LABELS[name]);
		} else if (kind === "tool_execution_end") {
			if (typeof data.toolCallId === "string") this.tools.delete(data.toolCallId);
		} else if (kind === "message_end") this.streamLabel = undefined;
		else if (["agent_start", "agent_end", "agent_settled", "session_start"].includes(kind)) {
			this.streamLabel = undefined;
			this.tools.clear();
		} else if (kind === "working_override")
			this.overrideLabel =
				typeof data.label === "string" && data.label !== "" ? data.label : undefined;
		return before !== this.label;
	}
}
