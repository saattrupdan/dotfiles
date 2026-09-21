import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import {
	createLaunchPlan,
	enforceRepository,
	findManifestForCwd,
	preparePrimarySessionHub,
	saveManifest,
	sessionDirectoryForCwd,
	tryAcquirePrimaryLease,
} from "./git.ts";

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

test("leases the primary checkout to only one active Pi process", async () => {
	const { root } = createRepo();
	const commonGitDir = path.resolve(root, command(root, ["rev-parse", "--git-common-dir"]));
	const first = await tryAcquirePrimaryLease(commonGitDir);
	assert.ok(first);
	assert.equal(await tryAcquirePrimaryLease(commonGitDir), null);
	const reloaded = await tryAcquirePrimaryLease(commonGitDir, first.token);
	assert.ok(reloaded);
	assert.equal(reloaded.token, first.token);
	await first.release();
	const next = await tryAcquirePrimaryLease(commonGitDir);
	assert.ok(next);
	await next.release();
});

test("publishes exactly one primary lease under concurrent acquisition", async () => {
	const { root } = createRepo();
	const commonGitDir = path.resolve(root, command(root, ["rev-parse", "--git-common-dir"]));
	const attempts = await Promise.all(Array.from({ length: 20 }, () => tryAcquirePrimaryLease(commonGitDir)));
	const winners = attempts.filter((lease) => lease !== null);
	assert.equal(winners.length, 1);
	await winners[0]!.release();
});

test("reclaims a stale primary-checkout lease", async () => {
	const { root } = createRepo();
	const commonGitDir = path.resolve(root, command(root, ["rev-parse", "--git-common-dir"]));
	fs.writeFileSync(
		path.join(commonGitDir, "pi-worktree-primary.json"),
		`${JSON.stringify({ pid: 2147483647, token: "stale" })}\n`,
	);
	const lease = await tryAcquirePrimaryLease(commonGitDir);
	assert.ok(lease);
	assert.notEqual(lease.token, "stale");
	await lease.release();
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

test("shares sessions when primary and concurrent agents launch from different subdirectories", async () => {
	const { root, agentDir } = createRepo();
	const primaryCwd = path.join(root, "primary-subdir");
	const concurrentCwd = path.join(root, "concurrent-subdir");
	fs.mkdirSync(primaryCwd);
	fs.mkdirSync(concurrentCwd);
	const canonicalRoot = command(root, ["rev-parse", "--show-toplevel"]);
	const commonGitDir = path.resolve(canonicalRoot, command(root, ["rev-parse", "--git-common-dir"]));
	await preparePrimarySessionHub(primaryCwd, canonicalRoot, commonGitDir, agentDir);
	const primarySessions = sessionDirectoryForCwd(primaryCwd, agentDir);
	fs.writeFileSync(path.join(primarySessions, "primary.jsonl"), '{"type":"session"}\n');
	const concurrent = await createLaunchPlan(concurrentCwd, agentDir);
	const concurrentSessions = sessionDirectoryForCwd(concurrent.childCwd, agentDir);

	assert.equal(fs.realpathSync(primarySessions), fs.realpathSync(concurrentSessions));
	assert.equal(fs.readFileSync(path.join(concurrentSessions, "primary.jsonl"), "utf8"), '{"type":"session"}\n');
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

test("reports a deleted launch branch without losing the detached commit", async () => {
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
