import { expect, test } from "bun:test";

import { createInteractiveQueue } from "./interactive-queue.ts";

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

test("serializes interactions in FIFO order", async () => {
	const queue = createInteractiveQueue();
	const firstRelease = deferred<void>();
	const events: string[] = [];

	const first = queue.run(async () => {
		events.push("first:start");
		await firstRelease.promise;
		events.push("first:end");
		return "first";
	});
	const second = queue.run(async () => {
		events.push("second:start");
		events.push("second:end");
		return "second";
	});
	const third = queue.run(async () => {
		events.push("third:start");
		return "third";
	});

	await Promise.resolve();
	expect(events).toEqual(["first:start"]);
	firstRelease.resolve();

	expect(await Promise.all([first, second, third])).toEqual(["first", "second", "third"]);
	expect(events).toEqual(["first:start", "first:end", "second:start", "second:end", "third:start"]);
});

test("removes an aborted queued interaction and continues FIFO", async () => {
	const queue = createInteractiveQueue();
	const firstRelease = deferred<void>();
	const queuedAbort = new AbortController();
	const events: string[] = [];

	const first = queue.run(async () => {
		events.push("first:start");
		await firstRelease.promise;
		events.push("first:end");
	});
	const aborted = queue.run(async () => {
		events.push("aborted:started");
	}, queuedAbort.signal);
	const third = queue.run(async () => {
		events.push("third:start");
		return "third";
	});

	queuedAbort.abort();
	await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
	expect(events).toEqual(["first:start"]);

	firstRelease.resolve();
	await expect(first).resolves.toBeUndefined();
	await expect(third).resolves.toBe("third");
	expect(events).toEqual(["first:start", "first:end", "third:start"]);
});

test("active abort rejects the interaction and releases the queue", async () => {
	const queue = createInteractiveQueue();
	const activeAbort = new AbortController();
	const events: string[] = [];

	const active = queue.run(
		(signal) =>
			new Promise<never>((_resolve, reject) => {
				signal.addEventListener(
					"abort",
					() => {
						const error = signal.reason instanceof Error ? signal.reason : new Error("aborted");
						reject(error);
					},
					{ once: true },
				);
			}),
		activeAbort.signal,
	);
	const next = queue.run(async () => {
		events.push("next:start");
		return "next";
	});

	await Promise.resolve();
	expect(events).toEqual([]);
	activeAbort.abort();

	await expect(active).rejects.toMatchObject({ name: "AbortError" });
	await expect(next).resolves.toBe("next");
	expect(events).toEqual(["next:start"]);
});

test("serializes only UI work while surrounding subagent work stays concurrent", async () => {
	const queue = createInteractiveQueue();
	const firstUiRelease = deferred<void>();
	const events: string[] = [];

	const runSubagent = async (name: string, waitForUi = false) => {
		events.push(`${name}:work:start`);
		await Promise.resolve();
		const interaction = queue.run(async () => {
			events.push(`${name}:ui:start`);
			if (waitForUi) await firstUiRelease.promise;
			events.push(`${name}:ui:end`);
		});
		events.push(`${name}:work:continued`);
		await interaction;
		events.push(`${name}:work:end`);
	};

	const first = runSubagent("first", true);
	const second = runSubagent("second");
	await Promise.resolve();
	await Promise.resolve();

	expect(events).toEqual([
		"first:work:start",
		"second:work:start",
		"first:ui:start",
		"first:work:continued",
		"second:work:continued",
	]);

	firstUiRelease.resolve();
	await Promise.all([first, second]);
	expect(events).toEqual([
		"first:work:start",
		"second:work:start",
		"first:ui:start",
		"first:work:continued",
		"second:work:continued",
		"first:ui:end",
		"second:ui:start",
		"second:ui:end",
		"first:work:end",
		"second:work:end",
	]);
});
