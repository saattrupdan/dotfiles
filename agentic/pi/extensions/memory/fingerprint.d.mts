export function fingerprintBundle(root: string): string;
export function failedJobKey(job: {
	id: string;
	text: string;
	attempts?: number;
	failedAt?: string;
	unknownOutcome?: boolean;
	retriedAt?: string;
}): string;
export function failedWorkSignature(root: string): string;
