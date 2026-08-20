/**
 * FIFO serialization for process-global interactive UI operations.
 *
 * The operation receives a signal derived from the caller's signal. An active
 * operation must honor that signal so an abort can release the queue slot.
 */

export type InteractiveOperation<T> = (signal: AbortSignal) => Promise<T>;

interface QueueEntry<T> {
	operation: InteractiveOperation<T>;
	signal: AbortSignal;
	callerSignal?: AbortSignal;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
	started: boolean;
	settled: boolean;
	onAbort: () => void;
}

export function interactiveAbortError(): Error {
	const error = new Error("Interactive request aborted");
	error.name = "AbortError";
	return error;
}

/** Serialize interactive operations while leaving surrounding work concurrent. */
export class InteractiveQueue {
	private readonly pending: QueueEntry<unknown>[] = [];
	private running = false;

	run<T>(operation: InteractiveOperation<T>, callerSignal?: AbortSignal): Promise<T> {
		if (callerSignal?.aborted) return Promise.reject(interactiveAbortError());

		return new Promise<T>((resolve, reject) => {
			const controller = new AbortController();
			const entry: QueueEntry<T> = {
				operation,
				signal: controller.signal,
				callerSignal,
				resolve,
				reject,
				started: false,
				settled: false,
				onAbort: () => undefined,
			};

			entry.onAbort = () => {
				controller.abort(interactiveAbortError());
				if (entry.started || entry.settled) return;

				const index = this.pending.indexOf(entry as QueueEntry<unknown>);
				if (index === -1) return;
				this.pending.splice(index, 1);
				entry.settled = true;
				this.cleanup(entry);
				reject(interactiveAbortError());
				this.pump();
			};

			callerSignal?.addEventListener("abort", entry.onAbort, { once: true });
			this.pending.push(entry as QueueEntry<unknown>);
			this.pump();
		});
	}

	private cleanup<T>(entry: QueueEntry<T>): void {
		entry.callerSignal?.removeEventListener("abort", entry.onAbort);
	}

	private pump(): void {
		if (this.running) return;
		this.running = true;
		void this.drain();
	}

	private async drain(): Promise<void> {
		try {
			while (this.pending.length > 0) {
				const entry = this.pending.shift();
				if (!entry || entry.settled) continue;

				if (entry.signal.aborted) {
					entry.settled = true;
					this.cleanup(entry);
					entry.reject(interactiveAbortError());
					continue;
				}

				entry.started = true;
				try {
					const value = await entry.operation(entry.signal);
					if (!entry.settled) {
						entry.settled = true;
						entry.resolve(value);
					}
				} catch (error) {
					if (!entry.settled) {
						entry.settled = true;
						entry.reject(error);
					}
				} finally {
					this.cleanup(entry);
				}
			}
		} finally {
			this.running = false;
			if (this.pending.length > 0) this.pump();
		}
	}
}

export function createInteractiveQueue(): InteractiveQueue {
	return new InteractiveQueue();
}
