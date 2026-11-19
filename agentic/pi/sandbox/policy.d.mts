export const SANDBOX_CONFIG: string;
export function repositorySandbox(cwd: string): { root: string; config: string } | undefined;
export function sandboxArguments(args: string[]): string[];
