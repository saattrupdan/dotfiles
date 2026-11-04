import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Pi loads extensions separately. Keep a single process-wide signal even if
// its TS loader evaluates this helper more than once.
type Listener = (active: boolean, ctx: ExtensionContext) => void;
export const LOOP_HANDOFF_ENV = "PI_LOOP_HANDOFF";

export interface LoopHandoff {
	sessionFile: string;
	intervalMs: number;
	prompt: string;
	condition?: string;
	maxRuns?: number;
	runs: number;
	phase: "running" | "waiting" | "complete";
	returnToBase: boolean;
}

type State = {
	active: boolean;
	listeners: Map<string, Listener>;
	handoff?: () => LoopHandoff | undefined;
	suspend?: () => void;
	returnToBase?: (ctx: ExtensionContext) => Promise<void>;
};
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

export function setLoopHandoffProvider(provider: () => LoopHandoff | undefined, suspend: () => void): void {
	state.handoff = provider;
	state.suspend = suspend;
}

export function suspendLoopForHandoff(): void {
	state.suspend?.();
}

export function getLoopHandoff(sessionFile: string): LoopHandoff | undefined {
	const handoff = state.handoff?.();
	return handoff?.sessionFile === sessionFile ? handoff : undefined;
}

export function setLoopReturnToBase(handler?: (ctx: ExtensionContext) => Promise<void>): void {
	state.returnToBase = handler;
}

export function hasLoopReturnToBase(): boolean {
	return state.returnToBase !== undefined;
}

export async function returnLoopToBase(ctx: ExtensionContext): Promise<boolean> {
	if (!state.returnToBase) return false;
	await state.returnToBase(ctx);
	return true;
}
