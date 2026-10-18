/** Install a verified migration stage while archiving the disposable pilot bundle. */

import console from "node:console";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function activate(root) {
	const stage = path.join(root, ".migration-stage");
	const archive = path.join(root, "requests", "pilot-archive");
	for (const folder of [root, stage, path.join(root, "requests")]) {
		const info = fs.lstatSync(folder);
		if (!info.isDirectory()) throw new Error("Activation requires real bundle, stage and queue directories");
	}
	if (fs.existsSync(archive)) throw new Error("Pilot archive already exists; activation may already be in progress");
	if (!fs.existsSync(path.join(stage, ".migration-report.json")) ||
		!fs.existsSync(path.join(stage, "embeddings.sqlite"))) throw new Error("Stage lacks a verified report or embeddings");
	if (!fs.existsSync(path.join(root, "requests", "paused"))) throw new Error("Pause new memory writes before activation");
	if (fs.readdirSync(path.join(root, "requests", "pending")).some((file) => file.endsWith(".json")) ||
		fs.readdirSync(path.join(root, "requests", "running")).some((file) => file.endsWith(".json"))) {
		throw new Error("Memory requests remain in flight");
	}
	const stageNames = fs.readdirSync(stage);
	if (stageNames.includes("requests") || !stageNames.includes("index.md")) {
		throw new Error("Stage conflicts with the request queue or lacks an OKF index");
	}
	const existing = fs.readdirSync(root).filter((name) => !["requests", ".migration-stage"].includes(name));
	fs.mkdirSync(archive, { mode: 0o700 });
	const movedPilot = [], movedStage = [];
	try {
		for (const name of existing) { fs.renameSync(path.join(root, name), path.join(archive, name)); movedPilot.push(name); }
		for (const name of stageNames) { fs.renameSync(path.join(stage, name), path.join(root, name)); movedStage.push(name); }
		fs.rmdirSync(stage);
		return { archivedPilotEntries: movedPilot.length, installedEntries: movedStage.length };
	} catch (error) {
		for (const name of movedStage.reverse()) fs.renameSync(path.join(root, name), path.join(stage, name));
		for (const name of movedPilot.reverse()) fs.renameSync(path.join(archive, name), path.join(root, name));
		fs.rmdirSync(archive);
		throw error;
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = path.join(os.homedir(), "memory");
	try { console.log(JSON.stringify(activate(root))); }
	catch (error) { console.error(error.message); process.exitCode = 1; }
}
