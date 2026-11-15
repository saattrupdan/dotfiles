import assert from "node:assert/strict";
import { test } from "node:test";
import { listEligibleUnassignedIssues } from "./issue-candidates.ts";

const issue = (number: number, total = 0, completed = 0, assigned = 0) => ({
	number, assignees: { totalCount: assigned }, subIssuesSummary: { total, completed },
});

test("paginates all issues and includes parents only when every child is closed", async () => {
	const calls: string[][] = [];
	const gh = async (args: string[], cwd: string) => {
		assert.equal(cwd, "/repo");
		calls.push(args);
		if (args[0] === "repo") return "example/project\n";
		return JSON.stringify({ data: { repository: { issues: calls.length === 2 ? {
			nodes: [issue(1, 2, 1), issue(2), issue(3, 0, 0, 1), issue(6, 3, 3)],
			pageInfo: { hasNextPage: true, endCursor: "next" },
		} : {
			nodes: [issue(4), issue(5, 1, 0), issue(7, 250, 250), issue(8, 250, 249), issue(9, 2, 2, 1)],
			pageInfo: { hasNextPage: false, endCursor: null },
		} } } });
	};
	assert.deepEqual(await listEligibleUnassignedIssues("/repo", undefined, gh), [2, 6, 4, 7]);
	assert.ok(calls[1]!.some((arg) => arg.includes("subIssuesSummary{total completed}")));
	assert.ok(calls[2]!.includes("cursor=next"));
});

test("missing or inconsistent completion counts fail closed rather than treating a parent as ready", async () => {
	for (const summary of [undefined, {}, { total: 1 }, { completed: 1 },
		{ total: -1, completed: 0 }, { total: 2, completed: -1 },
		{ total: 1, completed: 2 }, { total: 1.5, completed: 1 },
		{ total: "1", completed: "1" }, { total: null, completed: null }]) {
		const gh = async (args: string[]) => args[0] === "repo" ? "example/project" : JSON.stringify({
			data: { repository: { issues: {
				nodes: [{ ...issue(1), subIssuesSummary: summary }],
				pageInfo: { hasNextPage: false },
			} } },
		});
		await assert.rejects(listEligibleUnassignedIssues("/repo", undefined, gh), /invalid assignment or sub-issue completion counts/);
	}
});

test("incomplete GitHub relationships and pagination fail closed", async () => {
	const github = (response: unknown) => async (args: string[]) =>
		args[0] === "repo" ? "example/project" : JSON.stringify(response);
	await assert.rejects(listEligibleUnassignedIssues("/repo", undefined, github({
		data: { repository: { issues: { nodes: [{ number: 1, assignees: { totalCount: 0 } }], pageInfo: { hasNextPage: false } } } },
	})), /invalid assignment or sub-issue completion counts/);
	await assert.rejects(listEligibleUnassignedIssues("/repo", undefined, github({
		data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } },
	})), /pagination did not advance/);
	await assert.rejects(listEligibleUnassignedIssues("/repo", undefined, github({ errors: [{ message: "permission denied" }] })), /complete issue\/sub-issue listing/);
});
