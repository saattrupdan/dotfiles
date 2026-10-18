#!/usr/bin/env node
/** Inspect and retry native memory writes without exposing queue management as a Pi tool. */

import console from "node:console";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { counts, defaultRoot, list, queueRoot, readJob, retry, states, wake } from "./queue.mjs";

const [command, arg, ...flags] = process.argv.slice(2);
const root = defaultRoot();
const confirmed = flags.includes("--confirmed");
try {
	switch (command) {
		case "status": console.log(JSON.stringify(counts(root), null, 2)); break;
		case "list":
			if (arg && !states.includes(arg)) throw new Error(`Invalid state: ${arg}`);
			for (const state of arg ? [arg] : states) {
				for (const id of list(root, state)) {
					const job = readJob(root, state, id);
					console.log(`${state}\t${id}\t${job.createdAt}\t${job.error ?? ""}`);
				}
			}
			break;
		case "show":
			if (!arg) throw new Error("Supply a job ID");
			for (const state of states) {
				if (list(root, state).includes(arg)) { console.log(JSON.stringify(readJob(root, state, arg), null, 2)); process.exit(0); }
			}
			throw new Error(`Job not found: ${arg}`);
		case "retry":
			if (!arg) throw new Error("Supply a failed job ID");
			retry(root, arg, confirmed);
			wake(root);
			console.log(`Requeued ${arg}`);
			break;
		case "pause": fs.writeFileSync(path.join(queueRoot(root), "paused"), "paused\n", { mode: 0o600 }); console.log("Paused after current write"); break;
		case "resume":
			fs.rmSync(path.join(queueRoot(root), "paused"), { force: true });
			wake(root);
			console.log("Resumed");
			break;
		default: throw new Error("Usage: queue-cli.mjs status | list [state] | show ID | retry ID [--confirmed] | pause | resume");
	}
} catch (error) { console.error(error.message); process.exitCode = 1; }
