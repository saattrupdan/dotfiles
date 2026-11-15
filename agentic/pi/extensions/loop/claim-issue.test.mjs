import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import { claimIssue } from "./claim-issue.mjs";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("./claim-issue.mjs", import.meta.url));

function github(options = {}) {
	const state = { locked: false, assignments: 0, releases: 0, assignees: [], calls: [], ...options };
	const gh = async (args, cwd) => {
		assert.equal(cwd, "/checkout");
		state.calls.push(args);
		if (args[0] === "repo") return { nameWithOwner: "example/project", url: "https://github.example/example/project" };
		assert.deepEqual(args.slice(0, 3), ["api", "--hostname", "github.example"]);
		if (args[3] === "graphql") {
			if (args.some((arg) => arg.includes("defaultBranchRef"))) {
				return { data: { viewer: { login: "dan" }, repository: { defaultBranchRef: { target: { oid: "a".repeat(40) } } } } };
			}
			assert.ok(state.locked, "all issue checks must run under the remote lock");
			if (state.failRead) throw new Error("read failed");
			const assignees = state.assignments && state.afterAssignees ? state.afterAssignees : state.assignees;
			return { data: { repository: { issue: {
				number: 42, state: state.closed ? "CLOSED" : "OPEN",
				assignees: { totalCount: assignees.length, nodes: assignees.map((login) => ({ login })) },
				...(state.missingRelationship ? {} : { subIssuesSummary: state.summary ?? {
					total: state.parent ? 250 : 0,
					completed: state.parent ? (state.childrenClosed && !(state.assignments && state.reopenChildAfterAssignment) ? 250 : 249) : 0,
				} }),
			} } } };
		}
		if (args[3].endsWith("/assignees")) {
			assert.ok(state.locked);
			assert.ok(args.includes("assignees[]=dan"));
			state.assignments++;
			state.assignees.push("dan");
			if (state.failAssignment) throw new Error("assignment response lost");
			return {};
		}
		if (args.includes("DELETE")) {
			assert.equal(args[3], "repos/example/project/git/refs/pi/issue-claims/42");
			assert.ok(state.locked);
			if (state.failRelease) throw new Error("release failed");
			state.releases++;
			state.locked = false;
			return undefined;
		}
		assert.equal(args[3], "repos/example/project/git/refs");
		assert.ok(args.includes("POST"));
		assert.ok(args.includes("ref=refs/pi/issue-claims/42"));
		if (state.locked) throw Object.assign(new Error("HTTP 422"), { stdout: JSON.stringify({ message: "Reference already exists", status: "422" }) });
		if (state.permissionDenied) throw new Error("HTTP 403");
		state.locked = true;
		if (state.lostLockResponse) throw new Error("lock response lost");
		return { ref: "refs/pi/issue-claims/42" };
	};
	return { state, gh, claim: () => claimIssue(42, "/checkout", gh) };
}

test("concurrent same-account claims have exactly one winner, and @me never implies ownership", async () => {
	const h = github();
	const results = await Promise.all(Array.from({ length: 25 }, () => h.claim()));
	assert.equal(results.filter((result) => result.status === "claimed").length, 1);
	assert.equal(results.filter((result) => result.status === "busy").length, 24);
	assert.equal(h.state.assignments, 1);
	assert.equal(h.state.releases, 1);
	assert.equal((await h.claim()).status, "unavailable");
	assert.equal(h.state.assignments, 1);
});

for (const options of [{ assignees: ["other"] }, { assignees: ["dan"] }, { closed: true }, { parent: true }]) {
	test(`fresh issue state prevents assignment: ${JSON.stringify(options)}`, async () => {
		const h = github(options);
		assert.equal((await h.claim()).status, "unavailable");
		assert.equal(h.state.assignments, 0);
		assert.equal(h.state.releases, 1);
	});
}

test("a parent with all children closed is claimable, including beyond the first child page", async () => {
	const h = github({ parent: true, childrenClosed: true });
	assert.equal((await h.claim()).status, "claimed");
	assert.equal(h.state.assignments, 1);
	assert.equal(h.state.releases, 1);
	assert.ok(h.state.calls.some((args) => args.some((arg) => arg.includes("subIssuesSummary{total completed}"))));
});

test("reopening a child before assignment verification invalidates a parent's claim", async () => {
	const h = github({ parent: true, childrenClosed: true, reopenChildAfterAssignment: true });
	await assert.rejects(h.claim(), /Issue assignment could not be verified/);
	assert.equal(h.state.assignments, 1);
	assert.equal(h.state.locked, true);
	assert.equal(h.state.releases, 0);
});

for (const summary of [{ total: 2, completed: 3 }, { total: 2 }, { total: -1, completed: -1 }, { total: "2", completed: "2" }]) {
	test(`invalid child summary prevents assignment: ${JSON.stringify(summary)}`, async () => {
		const h = github({ summary });
		await assert.rejects(h.claim(), /sub-issue relationship/);
		assert.equal(h.state.assignments, 0);
		assert.equal(h.state.locked, true);
	});
}

test("an existing lock is never removed or expired", async () => {
	const h = github({ locked: true });
	assert.equal((await h.claim()).status, "busy");
	assert.equal(h.state.assignments, 0);
	assert.equal(h.state.releases, 0);
	assert.equal(h.state.calls.length, 3);
});

for (const options of [
	{ lostLockResponse: true }, { failRead: true }, { missingRelationship: true },
	{ failAssignment: true }, { afterAssignees: ["other"] },
	{ afterAssignees: ["dan", "other"] }, { failRelease: true },
]) {
	test(`uncertain outcomes fail closed and retain the lock: ${JSON.stringify(options)}`, async () => {
		const h = github(options);
		await assert.rejects(h.claim(), /do not implement|Do not implement/);
		assert.equal(h.state.locked, true);
		assert.equal(h.state.releases, 0);
		// Even if a write succeeded before its response was lost, never retry it.
		assert.equal((await h.claim()).status, "busy");
		assert.ok(h.state.assignments <= 1);
	});
}

test("permission errors are errors rather than false ownership or contention", async () => {
	const h = github({ permissionDenied: true });
	await assert.rejects(h.claim(), /Could not acquire.*HTTP 403/);
	assert.equal(h.state.assignments, 0);
	assert.equal(h.state.releases, 0);
});

test("invalid issue numbers fail before running gh", async () => {
	for (const number of [0, -1, NaN, 1.5, "42", Number.MAX_SAFE_INTEGER + 1]) {
		await assert.rejects(claimIssue(number, "/checkout", () => assert.fail("gh must not run")), /positive integer/);
	}
	await assert.rejects(execFileAsync(process.execPath, [script, "42;touch bad"]), (error) => {
		assert.equal(error.code, 1);
		assert.match(error.stderr, /Usage:/);
		return true;
	});
});

test("separate CLI processes coordinate through GitHub refs, ignoring GH_REPO overrides", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-claim-"));
	try {
		const fakeGh = `#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const root = process.env.CLAIM_TEST_ROOT;
const lock = join(root, 'lock');
const assignment = join(root, 'assigned');
const output = (value) => console.log(JSON.stringify(value));
if (process.env.GH_REPO) throw new Error('GH_REPO was not removed');
if (args[0] === 'repo') output({nameWithOwner:'example/project',url:'https://github.example/example/project'});
else if (args[3] === 'graphql') {
  if (args.some(arg => arg.includes('defaultBranchRef'))) output({data:{viewer:{login:'dan'},repository:{defaultBranchRef:{target:{oid:'a'.repeat(40)}}}}});
  else {
    if (!existsSync(lock)) throw new Error('unlocked issue check');
    const assigned = existsSync(assignment);
    output({data:{repository:{issue:{number:42,state:'OPEN',assignees:{totalCount:assigned?1:0,nodes:assigned?[{login:'dan'}]:[]},subIssuesSummary:{total:0,completed:0}}}}});
  }
} else if (args.includes('DELETE')) { rmSync(lock, {recursive:true}); }
else if (args[3].endsWith('/assignees')) {
  if (!existsSync(lock)) throw new Error('unlocked assignment');
  if (existsSync(assignment)) throw new Error('duplicate assignment');
  writeFileSync(assignment, 'dan'); output({});
} else {
  try { mkdirSync(lock); output({ref:'refs/pi/issue-claims/42'}); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    output({message:'Reference already exists',status:'422'}); process.exitCode=1;
  }
}
`;
		await writeFile(join(dir, "gh"), fakeGh, { mode: 0o755 });
		// gh's executable is ESM on both older and current Node versions.
		await writeFile(join(dir, "package.json"), '{"type":"module"}');
		const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_REPO: "wrong/repository", CLAIM_TEST_ROOT: dir };
		const run = async () => {
			try {
				const result = await execFileAsync(process.execPath, [script, "42"], { cwd: dir, env });
				return { code: 0, ...JSON.parse(result.stdout) };
			} catch (error) {
				assert.ok([3, 4].includes(error.code), error.stderr);
				return { code: error.code, ...JSON.parse(error.stdout) };
			}
		};
		const results = await Promise.all(Array.from({ length: 8 }, run));
		assert.equal(results.filter((result) => result.status === "claimed" && result.code === 0).length, 1);
		assert.equal(results.filter((result) => ["busy", "unavailable"].includes(result.status)).length, 7);
		assert.equal(await readFile(join(dir, "assigned"), "utf8"), "dan");
		assert.equal((await run()).status, "unavailable");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
