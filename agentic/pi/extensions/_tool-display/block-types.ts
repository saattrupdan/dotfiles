export type ToolLineStyle = "plain" | "command" | "added" | "removed";
export interface ToolBlock {
	text: string;
	styles: ToolLineStyle[];
}

export interface ToolProgress {
	toolCallId: string;
	toolDisplay: string;
	toolDisplayStyles: ToolLineStyle[];
}
