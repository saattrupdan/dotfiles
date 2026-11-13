import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Pi loads extensions separately. Keep a single process-wide signal even if
// its TS loader evaluates this helper more than once.
export interface LoopCompletion {
	id: string;
	sessionId: string;
	outcome: "finished" | "failed";
}
type CompletionListener = (completion: LoopCompletion, ctx: ExtensionContext) => void;
type Listener = (active: boolean, ctx: ExtensionContext) => void;
export const LOOP_HANDOFF_ENV = "PI_LOOP_HANDOFF";
// A stable code survives separate extension loaders and reloads.
export const LOOP_MAIN_DIRTY = "PI_LOOP_MAIN_DIRTY";

export interface LoopHandoff {
	completionId?: string;
	sessionFile: string;
	intervalMs: number;
	prompt: string;
	instruction?: string;
	condition?: string;
	maxRuns?: number;
	runs: number;
	phase: "running" | "waiting" | "complete";
	returnToBase: boolean;
}

type State = {
	active: boolean;
	listeners: Map<string, Listener>;
	completion?: LoopCompletion;
	completionListeners?: Map<string, CompletionListener>;
	handoff?: () => LoopHandoff | undefined;
	suspend?: () => void;
	restore?: (ctx: ExtensionContext) => void;
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
	if (value) state.completion = undefined;
	for (const listener of state.listeners.values()) listener(value, ctx);
}

export function onLoopChange(key: string, listener: Listener): void {
	state.listeners.set(key, listener);
}

export function setLoopHandoffProvider(
	provider: () => LoopHandoff | undefined,
	suspend: () => void,
	restore: (ctx: ExtensionContext) => void,
): void {
	state.handoff = provider;
	state.suspend = suspend;
	state.restore = restore;
}

export function restoreLoopForHandoff(ctx: ExtensionContext): void {
	state.restore?.(ctx);
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

// Only the loop owner reports a terminal verdict. A pause, stop, reload or
// handoff must never masquerade as successful completion.
export function reportLoopCompletion(id: string, outcome: LoopCompletion["outcome"], ctx: ExtensionContext): void {
	if (state.completion?.id === id) return;
	const completion = { id, sessionId: ctx.sessionManager.getSessionId(), outcome };
	state.completion = completion;
	for (const listener of state.completionListeners?.values() ?? []) listener(completion, ctx);
}

export function currentLoopCompletion(): LoopCompletion | undefined {
	return state.completion;
}

export function onLoopCompletion(key: string, listener: CompletionListener): () => void {
	const listeners = state.completionListeners ??= new Map();
	listeners.set(key, listener);
	return () => { if (listeners.get(key) === listener) listeners.delete(key); };
}
