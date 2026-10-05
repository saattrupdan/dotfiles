import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Pi loads extensions separately. Keep a single process-wide signal even if
// its TS loader evaluates this helper more than once.
type Listener = (active: boolean, ctx: ExtensionContext) => void;
type State = { active: boolean; listeners: Map<string, Listener> };
const root = globalThis as typeof globalThis & { __piLoopState?: State };
const state = root.__piLoopState ??= { active: false, listeners: new Map<string, Listener>() };

export function isLoopActive(): boolean {
	return state.active;
}

export function setLoopActive(value: boolean, ctx: ExtensionContext): void {
	if (state.active === value) return;
	state.active = value;
	for (const listener of state.listeners.values()) listener(value, ctx);
}

export function onLoopChange(key: string, listener: Listener): void {
	state.listeners.set(key, listener);
}
