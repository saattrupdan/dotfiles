/** Compact inference frames retain content once, rather than once per token. */
export function cleanMessage(message) {
	const { errorMessage: _error, diagnostics: _diagnostics, ...clean } = message;
	return clean;
}

export function packEvent(event) {
	if (event.type === "start") return { type: "start", partial: { ...cleanMessage(event.partial), content: [] } };
	if (event.type === "done" || event.type === "error") return event;
	const { partial, ...frame } = event;
	const block = partial.content[event.contentIndex];
	if (event.type.endsWith("_end")) frame.block = block;
	if (event.type.startsWith("toolcall_")) { frame.id = block?.id; frame.name = block?.name; }
	return frame;
}

export function unpackEvent(frame, state) {
	if (frame.type === "start") { state.partial = frame.partial; state.arguments = new Map(); return frame; }
	if (frame.type === "done" || frame.type === "error") return frame;
	const partial = state.partial;
	if (!partial) throw new Error("Sandbox inference update arrived before start");
	const index = frame.contentIndex;
	if (!Number.isInteger(index) || index < 0 || index > 10000) throw new Error("Invalid sandbox content index");
	if (frame.type === "text_start") partial.content[index] = { type: "text", text: "" };
	if (frame.type === "thinking_start") partial.content[index] = { type: "thinking", thinking: "" };
	if (frame.type === "toolcall_start") partial.content[index] = { type: "toolCall", id: frame.id ?? "", name: frame.name ?? "", arguments: {} };
	const block = partial.content[index];
	if (!block) throw new Error("Sandbox content block is missing");
	if (frame.type === "text_delta") block.text += frame.delta;
	if (frame.type === "thinking_delta") block.thinking += frame.delta;
	if (frame.type === "toolcall_delta") {
		const json = (state.arguments.get(index) ?? "") + frame.delta;
		state.arguments.set(index, json);
		block.id = frame.id ?? block.id; block.name = frame.name ?? block.name;
		try { block.arguments = JSON.parse(json); } catch { /* Incomplete JSON remains a preview until toolcall_end. */ }
	}
	if (frame.block) partial.content[index] = frame.block;
	const { block: _block, id: _id, name: _name, ...event } = frame;
	return { ...event, partial };
}
