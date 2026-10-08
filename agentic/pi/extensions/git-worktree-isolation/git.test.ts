import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recoveredFromRateLimit } from "./index.ts";
import {
	acquireResumeClaim,
	acquireSessionLease,
	assertWorktreeReleasable,
	checkpointSession,
	checkpointSessionIfPresent,
	checkpointWorktreeSessions,
	cleanLinkedIgnoredPaths,
	consumeResumeRecord,
	createLaunchPlan,
	createResumePlan,
	enforceRepository,
	findManifestForCwd,
	hydrateIgnoredPaths,
	loadResumeRecord,
	reapStaleWorktrees,
	releaseManagedWorktree,
	rewriteSessionCwd,
	saveManifest,
	sessionCwd,
	sessionDirectoryForCwd,
} from "./git.ts";

test("detects a rate-limit retry only in the current user request", () => {
	const entries = [
		{ type: "custom_message", customType: "rate-limit-retry:continue" },
		{ type: "message", message: { role: "assistant" } },
	];
	const ctx = { sessionManager: { getBranch: () => [...entries] } } as unknown as ExtensionContext;
	assert.equal(recoveredFromRateLimit(ctx), true);
	entries.push({ type: "message", message: { role: "user" } });
	assert.equal(recoveredFromRateLimit(ctx), false);
});

const temporaryRoots: string[] = [];

function command(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepo(): { root: string; agentDir: string } {
	const container = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-test-"));
	temporaryRoots.push(container);
	const root = path.join(container, "repo");
	const agentDir = path.join(container, "agent");
	fs.mkdirSync(root);
	command(root, ["init", "-b", "main"]);
	command(root, ["config", "user.email", "pi@example.invalid"]);
	command(root, ["config", "user.name", "Pi Test"]);
	fs.writeFileSync(path.join(root, "base.txt"), "base\n");
	command(root, ["add", "."]);
	command(root, ["commit", "-m", "chore: initial"]);
	return { root, agentDir };
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("creates a detached worktree without creating a branch", async () => {
	const { root, agentDir } = createRepo();
	const nested = path.join(root, "nested");
	fs.mkdirSync(nested);
	const plan = await createLaunchPlan(nested, agentDir);

	assert.throws(() => command(plan.manifest.worktreeRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
	assert.match(plan.manifest.id, /^[a-z]+-[a-z]+(?:-\d{4})?$/);
	assert.equal(command(root, ["branch", "--format=%(refname:short)"]), "main");
	assert.equal(plan.childCwd, path.join(plan.manifest.worktreeRoot, "nested"));
	assert.deepEqual((await findManifestForCwd(plan.childCwd))?.id, plan.manifest.id);
	const hub = fs.realpathSync(sessionDirectoryForCwd(root, agentDir));
	assert.equal(fs.realpathSync(sessionDirectoryForCwd(nested, agentDir)), hub);
	assert.equal(fs.realpathSync(sessionDirectoryForCwd(plan.childCwd, agentDir)), hub);
});

test("launches a detached checkout on its own publication branch", async () => {
	const { root, agentDir } = createRepo();
	command(root, ["checkout", "--detach"]);
	const plan = await createLaunchPlan(root, agentDir);
	assert.equal(plan.manifest.targetBranch, `pi/${plan.manifest.id}`);
	assert.equal(command(root, ["rev-parse", plan.manifest.targetRef]), command(plan.childCwd, ["rev-parse", "HEAD"]));
	fs.writeFileSync(path.join(plan.childCwd, "new.txt"), "new\n");
	command(plan.childCwd, ["add", "new.txt"]);
	command(plan.childCwd, ["commit", "-m", "feat: detached work"]);
	assert.equal((await enforceRepository(plan.manifest)).kind, "ok");
	assert.equal(command(root, ["rev-parse", plan.manifest.targetRef]), command(plan.childCwd, ["rev-parse", "HEAD"]));
	await releaseManagedWorktree(plan.manifest);
	assert.equal(command(root, ["rev-parse", "--abbrev-ref", "HEAD"]), "HEAD");
});

test("links ignored files, nested paths, and directories without exposing them to Git", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), ".env*\nignored.txt\nassets/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore local files"]);
	fs.writeFileSync(path.join(root, ".env"), "ROOT_SECRET=root\n");
	fs.writeFileSync(path.join(root, ".env.local"), "LOCAL_SECRET=local\n");
	const nested = path.join(root, "service");
	fs.mkdirSync(nested);
	fs.writeFileSync(path.join(nested, ".env.local"), "SERVICE_SECRET=service\n");
	fs.symlinkSync(".env", path.join(root, ".env.link"));
	fs.writeFileSync(path.join(root, "ignored.txt"), "ignored\n");
	fs.mkdirSync(path.join(root, "assets"));
	fs.writeFileSync(path.join(root, "assets", "data"), "cached\n");

	const plan = await createLaunchPlan(root, agentDir);
	const target = (relativePath: string) => path.join(plan.manifest.worktreeRoot, relativePath);
	assert.deepEqual(plan.manifest.linkedIgnoredPaths, [".env", ".env.link", ".env.local", "assets", "ignored.txt", "service/.env.local"]);
	for (const relativePath of plan.manifest.linkedIgnoredPaths ?? []) {
		assert.equal(fs.readlinkSync(target(relativePath)), path.join(fs.realpathSync(root), relativePath));
	}
	assert.equal(fs.readFileSync(target("assets/data"), "utf8"), "cached\n");
	assert.equal(fs.readlinkSync(target(".env.link")), path.join(fs.realpathSync(root), ".env.link"));
	assert.equal(command(plan.manifest.worktreeRoot, ["status", "--porcelain"]), "");
	fs.writeFileSync(target("assets/data"), "edited\n");
	assert.equal(fs.readFileSync(path.join(root, "assets/data"), "utf8"), "edited\n");

	await cleanLinkedIgnoredPaths(plan.manifest);
	assert.equal(fs.existsSync(target("assets")), false);
	assert.equal(fs.readFileSync(path.join(root, "assets/data"), "utf8"), "edited\n");
	await hydrateIgnoredPaths(plan.manifest);
	assert.equal(fs.readFileSync(target("assets/data"), "utf8"), "edited\n");
	assert.equal(command(plan.manifest.worktreeRoot, ["status", "--porcelain"]), "");
});

test("does not link dependency and cache directories into new worktrees", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), ".env\n.venv/\nnode_modules*/\n.pytest_cache/\nservice/__pycache__/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore build outputs"]);
	fs.writeFileSync(path.join(root, ".env"), "CONFIG=yes\n");
	for (const name of [".venv", "node_modules", "node_modules-brave-rabbit", ".pytest_cache", "service/__pycache__"]) {
		fs.mkdirSync(path.join(root, name), { recursive: true });
		fs.writeFileSync(path.join(root, name, "artifact"), "generated\n");
	}
	const plan = await createLaunchPlan(root, agentDir);
	assert.equal(fs.readlinkSync(path.join(plan.childCwd, ".env")), path.join(fs.realpathSync(root), ".env"));
	for (const name of [".venv", "node_modules", "node_modules-brave-rabbit", ".pytest_cache", "service/__pycache__"]) {
		assert.equal(fs.existsSync(path.join(plan.childCwd, name)), false, `${name} must not be inherited`);
	}
	fs.mkdirSync(path.join(plan.childCwd, ".venv"));
	fs.writeFileSync(path.join(plan.childCwd, ".venv", "new"), "session\n");
	await releaseManagedWorktree(plan.manifest);
	assert.equal(fs.readFileSync(path.join(root, `.venv-${plan.manifest.id}/new`), "utf8"), "session\n");
	const next = await createLaunchPlan(root, agentDir);
	assert.equal(fs.existsSync(path.join(next.childCwd, `.venv-${plan.manifest.id}`)), false);
});

test("releases and resumes linked ignored directories without deleting their contents", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), "assets/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore assets"]);
	fs.mkdirSync(path.join(root, "assets"));
	fs.writeFileSync(path.join(root, "assets", "result"), "keep\n");
	const plan = await createLaunchPlan(root, agentDir);
	assert.equal(command(plan.childCwd, ["status", "--porcelain"]), "");
	const sessionFile = path.join(agentDir, "resume.jsonl");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "resume", cwd: plan.childCwd })}\n`);
	const record = await checkpointSession(plan.manifest, sessionFile);
	await releaseManagedWorktree(plan.manifest);
	assert.equal(fs.readFileSync(path.join(root, "assets/result"), "utf8"), "keep\n");
	const resumed = await createResumePlan(record);
	assert.equal(fs.readlinkSync(path.join(resumed.childCwd, "assets")), path.join(fs.realpathSync(root), "assets"));
	assert.equal(command(resumed.childCwd, ["status", "--porcelain"]), "");
});

test("keeps ignored coverage local and discards generated coverage on release", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), ".coverage\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore coverage"]);
	fs.writeFileSync(path.join(root, ".coverage"), "original\n");
	const plan = await createLaunchPlan(root, agentDir);
	const coverage = path.join(plan.childCwd, ".coverage");
	assert.equal(plan.manifest.linkedIgnoredPaths?.includes(".coverage"), false);
	assert.equal(fs.existsSync(coverage), false);
	fs.writeFileSync(coverage, "generated\n");
	assert.equal(fs.readFileSync(path.join(root, ".coverage"), "utf8"), "original\n");
	await releaseManagedWorktree(plan.manifest);
	assert.equal(fs.readFileSync(path.join(root, ".coverage"), "utf8"), "original\n");
	assert.equal(fs.existsSync(plan.manifest.worktreeRoot), false);
});

test("discards replaced coverage links from older sessions", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), ".coverage\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore coverage"]);
	fs.writeFileSync(path.join(root, ".coverage"), "original\n");
	const plan = await createLaunchPlan(root, agentDir);
	const coverage = path.join(plan.childCwd, ".coverage");
	fs.symlinkSync(path.join(root, ".coverage"), coverage);
	plan.manifest.linkedIgnoredPaths?.push(".coverage");
	await saveManifest(plan.manifest);
	fs.unlinkSync(coverage);
	fs.writeFileSync(coverage, "generated\n");
	await releaseManagedWorktree(plan.manifest);
	assert.equal(fs.readFileSync(path.join(root, ".coverage"), "utf8"), "original\n");
	assert.equal(fs.existsSync(plan.manifest.worktreeRoot), false);
});

test("moves a replaced ignored link without deleting session data", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), "assets/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore assets"]);
	fs.mkdirSync(path.join(root, "assets"));
	fs.writeFileSync(path.join(root, "assets", "old"), "original\n");
	const plan = await createLaunchPlan(root, agentDir);
	fs.unlinkSync(path.join(plan.childCwd, "assets"));
	fs.mkdirSync(path.join(plan.childCwd, "assets"));
	fs.writeFileSync(path.join(plan.childCwd, "assets", "important"), "keep\n");
	await releaseManagedWorktree(plan.manifest);
	assert.equal(fs.readFileSync(path.join(root, `assets-${plan.manifest.id}/important`), "utf8"), "keep\n");
});

test("does not treat a tracked directory on a new branch as a replaced ignored link", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), "data/experiments/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore data"]);
	fs.mkdirSync(path.join(root, "data/experiments"), { recursive: true });
	fs.writeFileSync(path.join(root, "data/experiments/old.log"), "ignored\n");
	const plan = await createLaunchPlan(root, agentDir);
	assert.ok(plan.manifest.linkedIgnoredPaths?.includes("data/experiments"));
	fs.unlinkSync(path.join(plan.childCwd, "data/experiments"));
	fs.mkdirSync(path.join(plan.childCwd, "data/experiments"));
	fs.writeFileSync(path.join(plan.childCwd, "data/experiments/README.md"), "tracked\n");
	command(plan.childCwd, ["switch", "-c", "feat/tracked-experiments"]);
	command(plan.childCwd, ["add", "-f", "data/experiments/README.md"]);
	command(plan.childCwd, ["commit", "-m", "docs: track experiment guide"]);
	assert.equal((await enforceRepository(plan.manifest)).kind, "ok");
	await releaseManagedWorktree(plan.manifest);
	assert.equal(fs.existsSync(plan.childCwd), false);
	assert.equal(command(root, ["show", "feat/tracked-experiments:data/experiments/README.md"]), "tracked");
});

test("preserves ignored directories named .coverage", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), ".coverage/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore coverage"]);
	const plan = await createLaunchPlan(root, agentDir);
	fs.mkdirSync(path.join(plan.childCwd, ".coverage"));
	fs.writeFileSync(path.join(plan.childCwd, ".coverage", "important"), "keep\n");
	await assert.rejects(releaseManagedWorktree(plan.manifest), /Ignored path .coverage/);
	assert.equal(fs.readFileSync(path.join(plan.childCwd, ".coverage", "important"), "utf8"), "keep\n");
});

test("retains global excludes and safely quotes ignored path names", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, "global-excludes"), "*.global.tmp\n");
	command(root, ["config", "core.excludesFile", "global-excludes"]);
	fs.writeFileSync(path.join(root, ".gitignore"), "build[1]/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore build"]);
	fs.writeFileSync(path.join(root, "old.global.tmp"), "global\n");
	// Gitignore brackets are escaped here to match a literal name.
	fs.writeFileSync(path.join(root, ".gitignore"), "build\\[1\\]/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore literal build"]);
	fs.mkdirSync(path.join(root, "build[1]"));
	fs.writeFileSync(path.join(root, "build[1]", "artifact"), "built\n");
	const plan = await createLaunchPlan(root, agentDir);
	assert.equal(fs.readlinkSync(path.join(plan.childCwd, "build[1]")), path.join(fs.realpathSync(root), "build[1]"));
	fs.writeFileSync(path.join(plan.childCwd, "new.global.tmp"), "local\n");
	assert.equal(command(plan.childCwd, ["status", "--porcelain"]), "");
	await releaseManagedWorktree(plan.manifest);
	assert.equal(fs.readFileSync(path.join(root, "new.global.tmp"), "utf8"), "local\n");
});

test("preserves Git's default XDG global ignore file", async () => {
	const { root, agentDir } = createRepo();
	const previousXdg = process.env.XDG_CONFIG_HOME;
	const xdg = path.join(agentDir, "xdg");
	fs.mkdirSync(path.join(xdg, "git"), { recursive: true });
	fs.writeFileSync(path.join(xdg, "git", "ignore"), "*.global.tmp\n");
	process.env.XDG_CONFIG_HOME = xdg;
	try {
		const plan = await createLaunchPlan(root, agentDir);
		fs.writeFileSync(path.join(plan.childCwd, "new.global.tmp"), "local\n");
		assert.equal(command(plan.childCwd, ["status", "--porcelain"]), "");
		await releaseManagedWorktree(plan.manifest);
		assert.equal(fs.readFileSync(path.join(root, "new.global.tmp"), "utf8"), "local\n");
	} finally {
		if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = previousXdg;
	}
});

test("creates distinct worktrees for concurrent launches without contending on the real index", async () => {
	const { root, agentDir } = createRepo();
	const plans = await Promise.all(Array.from({ length: 8 }, () => createLaunchPlan(root, agentDir)));

	assert.equal(new Set(plans.map((plan) => plan.manifest.worktreeRoot)).size, plans.length);
	assert.equal(command(root, ["status", "--porcelain"]), "");
});

test("shares the repository session hub across managed worktrees", async () => {
	const { root, agentDir } = createRepo();
	const first = await createLaunchPlan(root, agentDir);
	const firstSessionDir = sessionDirectoryForCwd(first.childCwd, agentDir);
	fs.writeFileSync(path.join(firstSessionDir, "first.jsonl"), '{"type":"session"}\n');
	const second = await createLaunchPlan(root, agentDir);
	const secondSessionDir = sessionDirectoryForCwd(second.childCwd, agentDir);

	assert.equal(fs.realpathSync(firstSessionDir), fs.realpathSync(secondSessionDir));
	assert.equal(fs.readFileSync(path.join(secondSessionDir, "first.jsonl"), "utf8"), '{"type":"session"}\n');
});

test("shares sessions across launch subdirectories and their managed worktrees", async () => {
	const { root, agentDir } = createRepo();
	const firstCwd = path.join(root, "first-subdir");
	const secondCwd = path.join(root, "second-subdir");
	fs.mkdirSync(firstCwd);
	fs.mkdirSync(secondCwd);
	const first = await createLaunchPlan(firstCwd, agentDir);
	const firstLaunchSessions = sessionDirectoryForCwd(firstCwd, agentDir);
	const firstManagedSessions = sessionDirectoryForCwd(first.childCwd, agentDir);
	fs.writeFileSync(path.join(firstManagedSessions, "first.jsonl"), '{"type":"session"}\n');
	const second = await createLaunchPlan(secondCwd, agentDir);
	const secondLaunchSessions = sessionDirectoryForCwd(secondCwd, agentDir);
	const secondManagedSessions = sessionDirectoryForCwd(second.childCwd, agentDir);

	assert.equal(fs.realpathSync(firstLaunchSessions), fs.realpathSync(firstManagedSessions));
	assert.equal(fs.realpathSync(firstManagedSessions), fs.realpathSync(secondLaunchSessions));
	assert.equal(fs.realpathSync(secondLaunchSessions), fs.realpathSync(secondManagedSessions));
	assert.equal(fs.readFileSync(path.join(secondManagedSessions, "first.jsonl"), "utf8"), '{"type":"session"}\n');
});

test("snapshots and publishes a dirty launch checkout automatically", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, "base.txt"), "dirty\n");
	fs.writeFileSync(path.join(root, "untracked.txt"), "untracked\n");
	const plan = await createLaunchPlan(root, agentDir);

	assert.ok(plan.manifest.launchSnapshotCommit);
	assert.equal(fs.readFileSync(path.join(plan.manifest.worktreeRoot, "base.txt"), "utf8"), "dirty\n");
	assert.equal(fs.readFileSync(path.join(plan.manifest.worktreeRoot, "untracked.txt"), "utf8"), "untracked\n");
	assert.equal(command(plan.manifest.worktreeRoot, ["status", "--porcelain"]), "");
	assert.notEqual(command(root, ["status", "--porcelain"]), "");

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "ok");
	assert.equal(command(root, ["status", "--porcelain"]), "");
	assert.equal(fs.readFileSync(path.join(root, "base.txt"), "utf8"), "dirty\n");
	assert.equal(fs.readFileSync(path.join(root, "untracked.txt"), "utf8"), "untracked\n");
	assert.equal(command(root, ["rev-parse", "main"]), command(plan.manifest.worktreeRoot, ["rev-parse", "HEAD"]));
});

test("preserves partially staged launch content in a durable index checkpoint", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, "base.txt"), "staged version\n");
	command(root, ["add", "base.txt"]);
	fs.writeFileSync(path.join(root, "base.txt"), "working version\n");
	const plan = await createLaunchPlan(root, agentDir);

	assert.ok(plan.manifest.launchIndexCommit);
	assert.equal(command(root, ["show", `${plan.manifest.launchIndexCommit}:base.txt`]), "staged version");
	assert.equal(fs.readFileSync(path.join(plan.manifest.worktreeRoot, "base.txt"), "utf8"), "working version\n");
});

test("blocks index-only drift after a dirty launch snapshot", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, "base.txt"), "launch working version\n");
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(root, "base.txt"), "new staged version\n");
	command(root, ["add", "base.txt"]);
	fs.writeFileSync(path.join(root, "base.txt"), "launch working version\n");
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "agent.txt"), "agent\n");
	command(plan.manifest.worktreeRoot, ["add", "agent.txt"]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: agent work"]);

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "blocked");
	assert.match(result.kind === "blocked" ? result.message : "", /index changed/);
	assert.equal(command(root, ["show", ":base.txt"]), "new staged version");
	assert.equal(fs.readFileSync(path.join(root, "base.txt"), "utf8"), "launch working version\n");
});

test("safely applies agent changes on top of a dirty launch snapshot", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, "base.txt"), "launch snapshot\n");
	fs.writeFileSync(path.join(root, "temporary.txt"), "captured untracked file\n");
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "base.txt"), "agent result\n");
	fs.rmSync(path.join(plan.manifest.worktreeRoot, "temporary.txt"));
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "added.txt"), "agent addition\n");
	command(plan.manifest.worktreeRoot, ["add", "-A"]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: update launch snapshot"]);

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "ok");
	assert.equal(command(root, ["status", "--porcelain"]), "");
	assert.equal(fs.readFileSync(path.join(root, "base.txt"), "utf8"), "agent result\n");
	assert.equal(fs.existsSync(path.join(root, "temporary.txt")), false);
	assert.equal(fs.readFileSync(path.join(root, "added.txt"), "utf8"), "agent addition\n");
});

test("preserves a launch checkout that changes after its automatic snapshot", async () => {
	const { root, agentDir } = createRepo();
	const originalHead = command(root, ["rev-parse", "HEAD"]);
	fs.writeFileSync(path.join(root, "base.txt"), "snapshotted\n");
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(root, "base.txt"), "newer local edit\n");

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "blocked");
	assert.match(result.kind === "blocked" ? result.message : "", /changed after its automatic snapshot/);
	assert.equal(fs.readFileSync(path.join(root, "base.txt"), "utf8"), "newer local edit\n");
	assert.equal(command(root, ["rev-parse", "main"]), originalHead);
});

test("asks the agent to commit dirty managed work", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "new.txt"), "work\n");
	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "needs-agent");
});

test("publishes detached commits to the launch branch", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "session.txt"), "session\n");
	command(plan.manifest.worktreeRoot, ["add", "."]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: add session file"]);

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "ok");
	assert.equal(fs.readFileSync(path.join(root, "session.txt"), "utf8"), "session\n");
	assert.equal(command(root, ["rev-parse", "main"]), command(plan.manifest.worktreeRoot, ["rev-parse", "HEAD"]));
	assert.equal(command(root, ["branch", "--format=%(refname:short)"]), "main");
});

test("blocks publication before overwriting an ignored file", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore generated file"]);
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "ignored.txt"), "session\n");
	command(plan.manifest.worktreeRoot, ["add", "-f", "ignored.txt"]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: track ignored path"]);
	fs.writeFileSync(path.join(root, "ignored.txt"), "local\n");

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "blocked");
	assert.match(result.kind === "blocked" ? result.message : "", /collides with an untracked or ignored path/);
	assert.equal(fs.readFileSync(path.join(root, "ignored.txt"), "utf8"), "local\n");
});

test("blocks an incoming child path beneath an ignored file", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), "ignored\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore collision path"]);
	const plan = await createLaunchPlan(root, agentDir);
	fs.mkdirSync(path.join(plan.manifest.worktreeRoot, "ignored"));
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "ignored", "child.txt"), "session\n");
	command(plan.manifest.worktreeRoot, ["add", "-f", "ignored/child.txt"]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: add child path"]);
	fs.writeFileSync(path.join(root, "ignored"), "local ignored file\n");

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "blocked");
	assert.equal(fs.readFileSync(path.join(root, "ignored"), "utf8"), "local ignored file\n");
});

test("blocks an incoming file above an ignored child path", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), "ignored/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore collision directory"]);
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "ignored"), "session file\n");
	command(plan.manifest.worktreeRoot, ["add", "-f", "ignored"]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: add parent path"]);
	fs.mkdirSync(path.join(root, "ignored"));
	fs.writeFileSync(path.join(root, "ignored", "child.txt"), "local ignored child\n");

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "blocked");
	assert.equal(fs.readFileSync(path.join(root, "ignored", "child.txt"), "utf8"), "local ignored child\n");
});

test("preserves dirty-checkout drift after the branch ref was published", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, "base.txt"), "snapshotted\n");
	const plan = await createLaunchPlan(root, agentDir);
	const newHead = command(plan.manifest.worktreeRoot, ["rev-parse", "HEAD"]);
	plan.manifest.pendingSync = {
		oldHead: plan.manifest.baseSha,
		newHead,
		expectedDirtyTree: plan.manifest.launchSnapshotTree,
		expectedDirtyBase: plan.manifest.baseSha,
		expectedDirtyCommit: plan.manifest.launchSnapshotCommit,
		expectedIndexTree: plan.manifest.launchIndexTree,
		expectedIndexCommit: plan.manifest.launchIndexCommit,
	};
	plan.manifest.publishedHead = newHead;
	await saveManifest(plan.manifest);
	command(root, ["update-ref", "refs/heads/main", newHead, plan.manifest.baseSha]);
	fs.writeFileSync(path.join(root, "base.txt"), "new edit after publication\n");

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "blocked");
	assert.equal(fs.readFileSync(path.join(root, "base.txt"), "utf8"), "new edit after publication\n");
	assert.ok(plan.manifest.pendingSync);
});

test("recovers checkout synchronization after a crash following ref publication", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	const oldHead = command(root, ["rev-parse", "HEAD"]);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "session.txt"), "session\n");
	command(plan.manifest.worktreeRoot, ["add", "."]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: recoverable publication"]);
	const newHead = command(plan.manifest.worktreeRoot, ["rev-parse", "HEAD"]);
	plan.manifest.pendingSync = { oldHead, newHead };
	plan.manifest.publishedHead = newHead;
	await saveManifest(plan.manifest);
	command(root, ["update-ref", "refs/heads/main", newHead, oldHead]);

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "ok");
	assert.equal(fs.readFileSync(path.join(root, "session.txt"), "utf8"), "session\n");
	assert.equal(plan.manifest.pendingSync, undefined);
	assert.equal(command(root, ["status", "--porcelain"]), "");
});

test("leaves an agent-created feature branch untouched", async () => {
	const { root, agentDir } = createRepo();
	const originalMain = command(root, ["rev-parse", "main"]);
	const plan = await createLaunchPlan(root, agentDir);
	command(plan.manifest.worktreeRoot, ["switch", "-c", "feat/agent-choice"]);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "feature.txt"), "feature\n");
	command(plan.manifest.worktreeRoot, ["add", "."]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: agent choice"]);

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "ok");
	assert.equal(command(root, ["rev-parse", "main"]), originalMain);
	assert.equal(command(root, ["rev-parse", "feat/agent-choice"]), command(plan.manifest.worktreeRoot, ["rev-parse", "HEAD"]));
});

test("rebases non-conflicting concurrent work before publishing", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "session.txt"), "session\n");
	command(plan.manifest.worktreeRoot, ["add", "."]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: session change"]);

	fs.writeFileSync(path.join(root, "other.txt"), "other\n");
	command(root, ["add", "."]);
	command(root, ["commit", "-m", "feat: concurrent change"]);

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "ok");
	assert.equal(fs.readFileSync(path.join(root, "session.txt"), "utf8"), "session\n");
	assert.equal(fs.readFileSync(path.join(root, "other.txt"), "utf8"), "other\n");
});

test("preserves a branch commit that lands during rebase", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "session.txt"), "session\n");
	command(plan.manifest.worktreeRoot, ["add", "."]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: session work"]);
	fs.writeFileSync(path.join(root, "concurrent.txt"), "first\n");
	command(root, ["add", "."]);
	command(root, ["commit", "-m", "feat: first concurrent commit"]);

	const hook = path.join(root, ".git", "hooks", "post-rewrite");
	const sentinel = path.join(root, ".git", "pi-race-hook-fired");
	fs.writeFileSync(
		hook,
		`#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX\nif [ ! -f '${sentinel}' ]; then\n  touch '${sentinel}'\n  printf 'second\\n' > '${path.join(root, "during-rebase.txt")}'\n  git -C '${root}' add during-rebase.txt\n  git -C '${root}' commit -m 'feat: commit during rebase' >/dev/null\nfi\n`,
	);
	fs.chmodSync(hook, 0o755);

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "ok", JSON.stringify(result));
	assert.equal(fs.readFileSync(path.join(root, "session.txt"), "utf8"), "session\n");
	assert.equal(fs.readFileSync(path.join(root, "during-rebase.txt"), "utf8"), "second\n");
	const subjects = command(root, ["log", "--format=%s"]);
	assert.match(subjects, /feat: commit during rebase/);
	assert.match(subjects, /feat: session work/);
});

test("serializes concurrent detached publications", async () => {
	const { root, agentDir } = createRepo();
	const first = await createLaunchPlan(root, agentDir);
	const second = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(first.manifest.worktreeRoot, "first.txt"), "first\n");
	command(first.manifest.worktreeRoot, ["add", "."]);
	command(first.manifest.worktreeRoot, ["commit", "-m", "feat: first session"]);
	fs.writeFileSync(path.join(second.manifest.worktreeRoot, "second.txt"), "second\n");
	command(second.manifest.worktreeRoot, ["add", "."]);
	command(second.manifest.worktreeRoot, ["commit", "-m", "feat: second session"]);

	const results = await Promise.all([enforceRepository(first.manifest), enforceRepository(second.manifest)]);
	assert.deepEqual(results.map((result) => result.kind), ["ok", "ok"]);
	assert.equal(fs.readFileSync(path.join(root, "first.txt"), "utf8"), "first\n");
	assert.equal(fs.readFileSync(path.join(root, "second.txt"), "utf8"), "second\n");
});

test("accepts a deleted launch branch when another branch contains the detached commit", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "session.txt"), "session\n");
	command(plan.manifest.worktreeRoot, ["add", "."]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: session work"]);
	const sessionHead = command(plan.manifest.worktreeRoot, ["rev-parse", "HEAD"]);
	command(root, ["branch", "replacement", sessionHead]);
	command(root, ["switch", "--detach"]);
	command(root, ["branch", "-D", "main"]);

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "ok");
	assert.match(result.kind === "ok" ? (result.message ?? "") : "", /already contained in replacement/);
	assert.equal(plan.manifest.publishedHead, sessionHead);
});

test("reports a deleted sole launch branch even after the detached commit was published", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "session.txt"), "session\n");
	command(plan.manifest.worktreeRoot, ["add", "."]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: session work"]);
	assert.equal((await enforceRepository(plan.manifest)).kind, "ok");
	command(root, ["switch", "--detach"]);
	command(root, ["branch", "-D", "main"]);

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "blocked");
	assert.match(result.kind === "blocked" ? result.message : "", /no longer exists/);
});

test("reports a deleted launch branch without losing an unreachable detached commit", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "session.txt"), "session\n");
	command(plan.manifest.worktreeRoot, ["add", "."]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: session work"]);
	command(root, ["switch", "--detach"]);
	command(root, ["branch", "-D", "main"]);

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "blocked");
	assert.match(result.kind === "blocked" ? result.message : "", /no longer exists/);
	assert.equal(command(plan.manifest.worktreeRoot, ["show", "HEAD:session.txt"]), "session");
});

test("returns a repair prompt for a real rebase conflict", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.manifest.worktreeRoot, "base.txt"), "session\n");
	command(plan.manifest.worktreeRoot, ["add", "."]);
	command(plan.manifest.worktreeRoot, ["commit", "-m", "feat: session edit"]);

	fs.writeFileSync(path.join(root, "base.txt"), "concurrent\n");
	command(root, ["add", "."]);
	command(root, ["commit", "-m", "feat: concurrent edit"]);

	const result = await enforceRepository(plan.manifest);
	assert.equal(result.kind, "needs-agent");
	assert.match(result.kind === "needs-agent" ? result.prompt : "", /conflict/i);
	const retry = await enforceRepository(plan.manifest);
	assert.equal(retry.kind, "needs-agent");
	assert.match(retry.kind === "needs-agent" ? retry.prompt : "", /rebase conflict/i);
});

test("releases a finalized worktree and recreates it when the session resumes", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.childCwd, "session.txt"), "session\n");
	command(plan.childCwd, ["add", "session.txt"]);
	command(plan.childCwd, ["commit", "-m", "feat: session"]);
	assert.equal((await enforceRepository(plan.manifest)).kind, "ok");
	const publishedHead = command(root, ["rev-parse", "main"]);
	const sessionFile = path.join(agentDir, "session.jsonl");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "test", cwd: plan.childCwd })}\n{"type":"message"}\n`);

	const record = await checkpointSession(plan.manifest, sessionFile);
	assert.equal(await sessionCwd(sessionFile), record.placeholderCwd);
	assert.equal(command(root, ["rev-parse", record.resumeRef]), publishedHead);
	await releaseManagedWorktree(plan.manifest);
	assert.equal(fs.existsSync(plan.manifest.worktreeRoot), false);
	assert.equal(fs.existsSync(plan.manifest.manifestPath), false);
	assert.deepEqual(await loadResumeRecord(sessionFile), record);

	const resumed = await createResumePlan(record);
	assert.notEqual(resumed.manifest.worktreeRoot, plan.manifest.worktreeRoot);
	assert.equal(command(resumed.childCwd, ["rev-parse", "HEAD"]), publishedHead);
	assert.throws(() => command(resumed.childCwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
	await rewriteSessionCwd(sessionFile, resumed.childCwd);
	await consumeResumeRecord(record);
	assert.equal(await sessionCwd(sessionFile), resumed.childCwd);
	assert.equal(await loadResumeRecord(sessionFile), null);
	assert.throws(() => command(root, ["show-ref", "--verify", record.resumeRef]));
});

test("resumes at an advanced target branch while retaining the session branch identity", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	command(plan.childCwd, ["switch", "-c", "feat/session"]);
	fs.writeFileSync(path.join(plan.childCwd, "feature.txt"), "feature\n");
	command(plan.childCwd, ["add", "feature.txt"]);
	command(plan.childCwd, ["commit", "-m", "feat: feature"]);
	assert.equal((await enforceRepository(plan.manifest)).kind, "ok");
	assert.equal(plan.manifest.targetBranch, "feat/session");
	const sessionFile = path.join(agentDir, "feature.jsonl");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "feature", cwd: plan.childCwd })}\n`);
	const record = await checkpointSession(plan.manifest, sessionFile);
	await releaseManagedWorktree(plan.manifest);

	command(root, ["switch", "feat/session"]);
	fs.writeFileSync(path.join(root, "later.txt"), "later\n");
	command(root, ["add", "later.txt"]);
	command(root, ["commit", "-m", "feat: later"]);
	const advancedHead = command(root, ["rev-parse", "HEAD"]);
	const resumed = await createResumePlan(record);

	assert.equal(resumed.manifest.targetBranch, "feat/session");
	assert.equal(command(resumed.childCwd, ["rev-parse", "HEAD"]), advancedHead);
	assert.throws(() => command(resumed.childCwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
});

test("does not checkpoint or release an unsafe worktree", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	const sessionFile = path.join(agentDir, "dirty.jsonl");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "dirty", cwd: plan.childCwd })}\n`);
	fs.writeFileSync(path.join(plan.childCwd, "dirty.txt"), "dirty\n");

	await assert.rejects(checkpointSession(plan.manifest, sessionFile), /uncommitted changes/);
	await assert.rejects(releaseManagedWorktree(plan.manifest), /not clean/);
	assert.equal(fs.existsSync(plan.manifest.worktreeRoot), true);
	assert.equal(await loadResumeRecord(sessionFile), null);
});

test("moves previously unknown ignored files into the main checkout", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), "cache/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore cache"]);
	const plan = await createLaunchPlan(root, agentDir);
	fs.mkdirSync(path.join(plan.childCwd, "cache"));
	fs.writeFileSync(path.join(plan.childCwd, "cache", "result.bin"), "important\n");

	await assert.rejects(assertWorktreeReleasable(plan.manifest), /Ignored path cache/);
	await releaseManagedWorktree(plan.manifest);
	assert.equal(fs.readFileSync(path.join(root, "cache", "result.bin"), "utf8"), "important\n");
});

test("moves ignored output into the main checkout and suffixes collisions", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), "cache/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore cache"]);
	const plan = await createLaunchPlan(root, agentDir);
	fs.mkdirSync(path.join(plan.childCwd, "cache"));
	fs.writeFileSync(path.join(plan.childCwd, "cache", "result.bin"), "session\n");
	// Another session created this destination after our launch.
	fs.mkdirSync(path.join(root, "cache"));
	fs.writeFileSync(path.join(root, "cache", "result.bin"), "original\n");
	await releaseManagedWorktree(plan.manifest);
	assert.equal(fs.readFileSync(path.join(root, "cache", "result.bin"), "utf8"), "original\n");
	assert.equal(fs.readFileSync(path.join(root, `cache-${plan.manifest.id}`, "result.bin"), "utf8"), "session\n");
	assert.equal(fs.existsSync(plan.manifest.worktreeRoot), false);
});

test("crash recovery does not populate the newly created checkout", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), "cache/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore cache"]);
	const old = await createLaunchPlan(root, agentDir);
	fs.mkdirSync(path.join(old.childCwd, "cache"));
	fs.writeFileSync(path.join(old.childCwd, "cache", "artifact"), "old\n");
	old.manifest.ownerPid = 99999999;
	await saveManifest(old.manifest);
	const current = await createLaunchPlan(root, agentDir);
	await reapStaleWorktrees(root);
	assert.equal(fs.readFileSync(path.join(root, "cache/artifact"), "utf8"), "old\n");
	assert.equal(fs.existsSync(path.join(current.childCwd, "cache")), false);
});

test("simultaneous exits cannot overwrite another session's ignored output", async () => {
	const { root, agentDir } = createRepo();
	fs.writeFileSync(path.join(root, ".gitignore"), "output/\n");
	command(root, ["add", ".gitignore"]);
	command(root, ["commit", "-m", "chore: ignore output"]);
	const first = await createLaunchPlan(root, agentDir);
	const second = await createLaunchPlan(root, agentDir);
	for (const [plan, value] of [[first, "first"], [second, "second"]] as const) {
		fs.mkdirSync(path.join(plan.childCwd, "output"));
		fs.writeFileSync(path.join(plan.childCwd, "output", "result"), value);
	}
	await Promise.all([releaseManagedWorktree(first.manifest), releaseManagedWorktree(second.manifest)]);
	const results = [
		path.join(root, "output", "result"),
		path.join(root, `output-${first.manifest.id}`, "result"),
		path.join(root, `output-${second.manifest.id}`, "result"),
	].filter((file) => fs.existsSync(file)).map((file) => fs.readFileSync(file, "utf8"));
	assert.deepEqual(results.sort(), ["first", "second"]);
});

test("keeps session-only ignored output private after moving it to main", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	command(plan.childCwd, ["switch", "-c", "feat/private-output"]);
	fs.writeFileSync(path.join(plan.childCwd, ".gitignore"), "private/\n");
	command(plan.childCwd, ["add", ".gitignore"]);
	command(plan.childCwd, ["commit", "-m", "chore: ignore private output"]);
	fs.mkdirSync(path.join(plan.childCwd, "private"));
	fs.writeFileSync(path.join(plan.childCwd, "private", "secret"), "do not stage\n");
	assert.equal((await enforceRepository(plan.manifest)).kind, "ok");
	await releaseManagedWorktree(plan.manifest);
	assert.equal(fs.readFileSync(path.join(root, "private", "secret"), "utf8"), "do not stage\n");
	assert.equal(command(root, ["status", "--porcelain"]), "");
	assert.equal(command(root, ["check-ignore", "private/secret"]), "private/secret");
});

test("recovers clean worktrees after an abrupt exit without reclaiming live owners", async () => {
	const { root, agentDir } = createRepo();
	const stale = await createLaunchPlan(root, agentDir);
	const sessionDir = sessionDirectoryForCwd(stale.childCwd, agentDir);
	const sessionFile = path.join(sessionDir, "crashed.jsonl");
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "crashed", cwd: stale.childCwd })}\n`);
	const active = await createLaunchPlan(root, agentDir);
	stale.manifest.ownerPid = 99999999;
	await saveManifest(stale.manifest);
	assert.deepEqual(await reapStaleWorktrees(root), [stale.manifest.worktreeRoot]);
	assert.equal(fs.existsSync(stale.manifest.worktreeRoot), false);
	assert.ok(await loadResumeRecord(sessionFile));
	assert.equal(fs.existsSync(active.manifest.worktreeRoot), true);
});

test("reclaims legacy worktrees only after their transcript lease ends", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	const sessionFile = path.join(sessionDirectoryForCwd(plan.childCwd, agentDir), "legacy.jsonl");
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "legacy", cwd: plan.childCwd })}\n`);
	delete plan.manifest.ownerPid;
	plan.manifest.createdAt = "2020-01-01T00:00:00.000Z";
	await saveManifest(plan.manifest);
	fs.writeFileSync(`${sessionFile}.pi-worktree.lock`, JSON.stringify({ pid: process.pid }));
	assert.deepEqual(await reapStaleWorktrees(root), []);
	assert.equal(fs.existsSync(plan.childCwd), true);
	fs.unlinkSync(`${sessionFile}.pi-worktree.lock`);
	assert.deepEqual(await reapStaleWorktrees(root), [plan.manifest.worktreeRoot]);
	assert.ok(await loadResumeRecord(sessionFile));
});

test("recovers transcripts and refs left by an already removed worktree", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	const sessionFile = path.join(sessionDirectoryForCwd(plan.childCwd, agentDir), "orphaned.jsonl");
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "orphaned", cwd: plan.childCwd })}\n`);
	command(root, ["worktree", "unlock", plan.manifest.worktreeRoot]);
	command(root, ["worktree", "remove", "--force", plan.manifest.worktreeRoot]);
	plan.manifest.ownerPid = 99999999;
	await saveManifest(plan.manifest);
	assert.deepEqual(await reapStaleWorktrees(root), []);
	assert.equal(fs.existsSync(plan.manifest.manifestPath), false);
	const record = await loadResumeRecord(sessionFile);
	assert.ok(record);
	assert.equal(record.resumeSha, plan.manifest.publishedHead);
	assert.equal(await sessionCwd(sessionFile), record.placeholderCwd);
	const resumed = await createResumePlan(record);
	assert.equal(command(resumed.childCwd, ["rev-parse", "HEAD"]), record.resumeSha);
});

test("does not reclaim a crashed session with uncommitted work", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	fs.writeFileSync(path.join(plan.childCwd, "unfinished.txt"), "keep\n");
	plan.manifest.ownerPid = 99999999;
	await saveManifest(plan.manifest);
	assert.deepEqual(await reapStaleWorktrees(root), []);
	assert.equal(fs.readFileSync(path.join(plan.childCwd, "unfinished.txt"), "utf8"), "keep\n");
});

test("checkpoints every legacy transcript that still references a released worktree", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	const sessionDir = sessionDirectoryForCwd(plan.childCwd, agentDir);
	const first = path.join(sessionDir, "first.jsonl");
	const second = path.join(sessionDir, "second.jsonl");
	fs.writeFileSync(first, `${JSON.stringify({ type: "session", id: "first", cwd: plan.childCwd })}\n`);
	fs.writeFileSync(second, `${JSON.stringify({ type: "session", id: "second", cwd: plan.childCwd })}\n`);

	const records = await checkpointWorktreeSessions(plan.manifest, first);

	assert.equal(records.length, 2);
	assert.notEqual(await sessionCwd(first), plan.childCwd);
	assert.notEqual(await sessionCwd(second), plan.childCwd);
	assert.ok(await loadResumeRecord(first));
	assert.ok(await loadResumeRecord(second));
});

test("allows an allocated session path before Pi creates its transcript", async () => {
	const { root, agentDir } = createRepo();
	const plan = await createLaunchPlan(root, agentDir);
	const sessionDir = sessionDirectoryForCwd(plan.childCwd, agentDir);
	const sessionFile = path.join(sessionDir, "not-created-yet.jsonl");

	const releaseLease = await acquireSessionLease(sessionFile);
	assert.equal(await checkpointSessionIfPresent(plan.manifest, sessionFile), null);
	assert.deepEqual(await checkpointWorktreeSessions(plan.manifest, sessionFile), []);
	await releaseLease();
	await releaseManagedWorktree(plan.manifest);
	assert.equal(fs.existsSync(plan.manifest.worktreeRoot), false);
});

test("serializes released-session activation and active transcript ownership", async () => {
	const { agentDir } = createRepo();
	const sessionFile = path.join(agentDir, "leased.jsonl");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "leased", cwd: agentDir })}\n`);

	const releaseClaim = await acquireResumeClaim(sessionFile);
	await assert.rejects(acquireResumeClaim(sessionFile), /already active/);
	await releaseClaim();
	const releaseReplacementClaim = await acquireResumeClaim(sessionFile);
	await releaseReplacementClaim();

	const releaseLease = await acquireSessionLease(sessionFile);
	await assert.rejects(acquireSessionLease(sessionFile), /already active/);
	await releaseLease();
});
