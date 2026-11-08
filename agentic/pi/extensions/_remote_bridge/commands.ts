/** Explicit adapters reuse local command behavior without interpreting user text. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
type Handler = (args: string, ctx: ExtensionContext) => Promise<void>;
const root = globalThis as typeof globalThis & { __piRemoteCommands?: Map<string, Handler> };
const commands = (root.__piRemoteCommands ??= new Map<string, Handler>());
export const registerRemoteCommand = (name: string, handler: Handler) => {
	commands.set(name, handler);
};
export const hasRemoteCommand = (name: string) => commands.has(name);
export const clearRemoteCommands = () => commands.clear();
export async function invokeRemoteCommand(name: string, args: string, ctx: ExtensionContext) {
	const handler = commands.get(name);
	if (!handler) throw new Error("unsupported_command");
	await handler(args, ctx);
}
