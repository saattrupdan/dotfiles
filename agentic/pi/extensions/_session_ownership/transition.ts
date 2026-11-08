/** Scope reservations to a complete supported SDK transition, including cancellation. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { acquire, release, releaseNamespace, reserveNamespace, type Owner } from "./ownership.mjs";
export interface OwnershipState {
	files: Set<string>;
	owner: Owner;
	root: string;
	current?: string;
	context?: ExtensionContext;
	transition?: { shutdown: boolean; started: boolean };
}
export const ownershipState = () =>
	(globalThis as typeof globalThis & { __piSessionOwnership?: OwnershipState })
		.__piSessionOwnership;
export async function withOwnedTransition<T>(operation: () => Promise<T>): Promise<T> {
	const state = ownershipState();
	if (!state) return operation();
	if (state.transition) throw new Error("A session transition is already in progress");
	reserveNamespace(state.owner, state.root);
	const transition = (state.transition = { shutdown: false, started: false });
	try {
		return await operation();
	} finally {
		// Failed creation after teardown has no usable context. Keep every reservation
		// until the process exits rather than guessing whether its writers stopped.
		if (!transition.shutdown || transition.started) {
			const manager = state.context?.sessionManager;
			const file = manager?.getSessionFile();
			if (file) {
				acquire(file, state.owner, state.root, manager!.getSessionId());
				state.files.add(file);
			}
			state.current = file;
			for (const previous of state.files)
				if (previous !== file) {
					release(previous, state.owner, state.root);
					state.files.delete(previous);
				}
			releaseNamespace(state.owner, state.root);
		}
		state.transition = undefined;
	}
}
