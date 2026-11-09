/** Start supervised Pi, adopting protected reservations before opening session files. */
import { pathToFileURL } from "node:url";
import {
	adopt,
	newOwner,
	OWNERSHIP_ENV,
	lockRoot,
} from "../extensions/_session_ownership/ownership.mjs";
const cli = process.argv[2];
if (process.env[OWNERSHIP_ENV]) {
	const previous = JSON.parse(process.env[OWNERSHIP_ENV]);
	const owner = { ...newOwner(previous.kind), instanceId: previous.instanceId };
	adopt(previous, owner, lockRoot());
	process.env[OWNERSHIP_ENV] = JSON.stringify(owner);
}
process.argv = [process.argv[0], cli, ...process.argv.slice(3)];
await import(pathToFileURL(cli).href);
