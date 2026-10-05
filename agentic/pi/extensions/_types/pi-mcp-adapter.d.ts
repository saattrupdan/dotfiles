// The adapter ships raw .ts as its types entry, which pulls its entire implementation
// into this project's typecheck. Only its default extension factory is used here.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

declare const mcpAdapter: (pi: ExtensionAPI) => void;
export default mcpAdapter;
