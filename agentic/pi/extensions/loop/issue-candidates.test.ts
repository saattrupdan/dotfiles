import assert from "node:assert/strict";
import { test } from "node:test";
import { listUnassignedLeafIssues } from "./issue-candidates.ts";

test("paginates every issue and excludes unassigned parents using GitHub sub-issue links", async () => {
	const calls: string[][] = [];
	const gh = async (args: string[], cwd: string) => {
		assert.equal(cwd, "/repo");
		calls.push(args);
		if (args[0] === "repo") return "example/project\n";
		return JSON.stringify({ data: { repository: { issues: calls.length === 2 ? {
			nodes: [
				{ number: 1, assignees: { totalCount: 0 }, subIssues: { totalCount: 2 } },
				{ number: 2, assignees: { totalCount: 0 }, subIssues: { totalCount: 0 } },
				{ number: 3, assignees: { totalCount: 1 }, subIssues: { totalCount: 0 } },
			],
			pageInfo: { hasNextPage: true, endCursor: "next" },
		} : {
			nodes: [
				{ number: 4, assignees: { totalCount: 0 }, subIssues: { totalCount: 0 } },
				{ number: 5, assignees: { totalCount: 0 }, subIssues: { totalCount: 1 } },
			],
			pageInfo: { hasNextPage: false, endCursor: null },
		} } } });
	};
	assert.deepEqual(await listUnassignedLeafIssues("/repo", undefined, gh), [2, 4]);
	assert.ok(calls[1]!.some((arg) => arg.includes("subIssues(first:1){totalCount}")));
	assert.ok(calls[2]!.includes("cursor=next"));
});

test("incomplete GitHub relationships and pagination fail closed", async () => {
	const github = (response: unknown) => async (args: string[]) =>
		args[0] === "repo" ? "example/project" : JSON.stringify(response);
	await assert.rejects(listUnassignedLeafIssues("/repo", undefined, github({
		data: { repository: { issues: { nodes: [{ number: 1, assignees: { totalCount: 0 } }], pageInfo: { hasNextPage: false } } } },
	})), /omitted an issue's assignment or sub-issue relationship/);
	await assert.rejects(listUnassignedLeafIssues("/repo", undefined, github({
		data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } },
	})), /pagination did not advance/);
	await assert.rejects(listUnassignedLeafIssues("/repo", undefined, github({ errors: [{ message: "permission denied" }] })), /complete issue\/sub-issue listing/);
});
