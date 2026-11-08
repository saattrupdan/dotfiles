/** Successful extension initialization attestations, shared across loader instances. */
const root = globalThis as typeof globalThis & { __piRemoteGuards?: Set<string> };
const guards = (root.__piRemoteGuards ??= new Set<string>());
export const markGuard = (name: string) => {
	guards.add(name);
};
export const missingGuards = (names: string[]) => names.filter((name) => !guards.has(name));
export const clearGuards = () => guards.clear();
