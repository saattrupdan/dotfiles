/** Group reads in the terminal's drawing layer; retain the native transcript and expansion state. */
import type {
	AssistantMessageComponent,
	ExtensionUIContext,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";

export interface NativeRows {
	AssistantMessageComponent: typeof AssistantMessageComponent;
	ToolExecutionComponent: typeof ToolExecutionComponent;
}

interface ReadRow extends Component {
	toolName: string;
	expanded: boolean;
	isPartial: boolean;
	outputPad: number;
	result?: { isError?: boolean };
	setExpanded(expanded: boolean): void;
}

interface View {
	theme(): ExtensionUIContext["theme"];
	requestRender(): void;
}

const ATTACHED = Symbol.for("pi.readGroups.chat");

class ReadGroup implements Component {
	private height = 0;

	constructor(private reads: ReadRow[], private view: View) {}

	render(width: number): string[] {
		const theme = this.view.theme();
		const label = `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", `${this.reads.length} file chunks`)}`;
		const background = this.reads.some((read) => read.isPartial) ? "toolPendingBg" : "toolSuccessBg";
		const box = new Box(this.reads[0]!.outputPad, 1, (line) => theme.bg(background, line));
		box.addChild(new Text(label, 0, 0));
		const lines = ["", ...box.render(width)];
		this.height = lines.length;
		return lines;
	}

	invalidate(): void {}

	handleMouse(event: TuiMouseEvent) {
		if (event.type !== "click" || event.button !== "left" || event.y <= 1 || event.y >= this.height - 1)
			return undefined;
		for (const read of this.reads) read.setExpanded(true);
		this.view.requestRender();
		return { handled: true };
	}
}

/** Attach once to the main chat only. Native children stay available to every existing Pi control. */
export function attachReadGroups(chat: Container, native: NativeRows, view: View): void {
	const marked = chat as Container & { [ATTACHED]?: boolean };
	if (marked[ATTACHED]) return;
	const originalRender = chat.render.bind(chat);
	const originalMouse = chat.handleMouse.bind(chat);
	const projected = new Container();
	let enabled = true;

	chat.render = (width) => {
		if (!enabled) return originalRender(width);
		try {
			projected.clear();
			let run: Component[] = [];
			let reads: ReadRow[] = [];
			const flush = () => {
				if (reads.length >= 2) projected.addChild(new ReadGroup(reads, view));
				else for (const child of run) projected.addChild(child);
				run = [];
				reads = [];
			};
			for (const child of chat.children) {
				if (child instanceof native.ToolExecutionComponent) {
					const read = child as unknown as ReadRow;
					if (read.toolName === "read" && read.expanded === false && !read.result?.isError) {
						run.push(child);
						reads.push(read);
						continue;
					}
				} else if (child instanceof native.AssistantMessageComponent && child.render(width).length === 0) {
					// Tool-only assistant messages are invisible between sequential calls, including in history.
					run.push(child);
					continue;
				}
				flush();
				projected.addChild(child);
			}
			flush();
			return projected.render(width);
		} catch (error) {
			// An incompatible Pi update restores its normal rows instead of losing the transcript.
			enabled = false;
			console.warn("[read-groups] Restoring native tool rows:", error);
			return originalRender(width);
		}
	};
	chat.handleMouse = (event) => enabled ? projected.handleMouse(event) : originalMouse(event);
	marked[ATTACHED] = true;
}
