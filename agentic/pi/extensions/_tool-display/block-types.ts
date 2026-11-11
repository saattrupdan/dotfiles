export type ToolLineStyle = "plain" | "command" | "added" | "removed";
export interface ToolBlock {
	text: string;
	styles: ToolLineStyle[];
}
