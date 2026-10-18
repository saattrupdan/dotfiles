export interface Job {
	id: string;
	text: string;
	createdAt: string;
	attempts: number;
	completedAt?: string;
	failedAt?: string;
	unknownOutcome?: boolean;
	error?: string;
}
export function defaultRoot(): string;
export function enqueue(text: string, root?: string): string;
export function counts(root?: string): Record<string, number>;
export function wake(root?: string, agentDir?: string): void;
export function retry(root: string, id: string, confirmed?: boolean): Job;
