/** Fetch open unassigned GitHub issues with no unfinished children; never guess on a partial listing. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PAGE_LIMIT = 100;
const QUERY = "query($owner:String!,$repo:String!,$cursor:String){repository(owner:$owner,name:$repo){issues(first:100,states:OPEN,after:$cursor){nodes{number assignees(first:1){totalCount} subIssuesSummary{total completed}} pageInfo{hasNextPage endCursor}}}}";

export const ISSUE_CONDITION = "No actionable unassigned issues remain: independently check every open unassigned issue using GitHub's parent–sub-issue relationship. Leaves and parents whose children are all closed are candidates. Parents with open children must wait. For eligible parents, verify the parent requirements, child implementations and merged PRs: closed children alone do not prove delivery. A fully delivered parent still needs verification and closing, not a new implementation or PR. Complex issues without children must first be decomposed and linked; remaining eligible issues must have documented blockers or missing clarifications; decision-blocked issues also require the repo's standard decision-blocker label or decision-blocked label";

type Gh = (args: string[], cwd: string, signal?: AbortSignal) => Promise<string>;

async function runGh(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
	// Select the checkout's remote, not a GH_REPO override inherited from the shell.
	const env = { ...process.env };
	delete env.GH_REPO;
	const { stdout } = await execFileAsync("gh", args, { cwd, env, signal, timeout: 30_000, maxBuffer: 2_000_000 });
	return stdout.trim();
}

/** All candidate numbers, not just the first page. Parents qualify once GitHub reports every child closed, including beyond one child page. */
export async function listEligibleUnassignedIssues(cwd: string, signal?: AbortSignal, gh: Gh = runGh): Promise<number[]> {
	const repository = (await gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd, signal)).trim();
	if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Could not identify this GitHub repository.");
	const [owner, repo] = repository.split("/");
	const candidates: number[] = [];
	let cursor: string | undefined;
	const seen = new Set<string>();
	for (let page = 0; page < PAGE_LIMIT; page++) {
		const args = ["api", "graphql", "-f", `query=${QUERY}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`];
		if (cursor) args.push("-f", `cursor=${cursor}`);
		const response = JSON.parse(await gh(args, cwd, signal)) as {
			errors?: unknown[];
			data?: { repository?: { issues?: {
				nodes?: Array<{ number: number; assignees?: { totalCount: number }; subIssuesSummary?: { total: number; completed: number } }>;
				pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
			} } };
		};
		const issues = response.data?.repository?.issues;
		if (response.errors?.length || !issues || !Array.isArray(issues.nodes) ||
			typeof issues.pageInfo?.hasNextPage !== "boolean") {
			throw new Error("GitHub did not return a complete issue/sub-issue listing.");
		}
		for (const issue of issues.nodes) {
			const summary = issue.subIssuesSummary;
			if (!Number.isSafeInteger(issue.number) || issue.number < 1 || !issue.assignees || !summary ||
				!Number.isSafeInteger(issue.assignees.totalCount) || issue.assignees.totalCount < 0 ||
				!Number.isSafeInteger(summary.total) || !Number.isSafeInteger(summary.completed) ||
				summary.total < 0 || summary.completed < 0 || summary.completed > summary.total) {
				throw new Error("GitHub omitted or returned invalid assignment or sub-issue completion counts.");
			}
			if (issue.assignees.totalCount === 0 && summary.completed === summary.total) candidates.push(issue.number);
		}
		if (!issues.pageInfo.hasNextPage) return candidates;
		const next = issues.pageInfo.endCursor;
		if (!next || seen.has(next)) throw new Error("GitHub issue pagination did not advance.");
		seen.add(next);
		cursor = next;
	}
	throw new Error("GitHub has too many open issues to verify every parent; issue selection stopped.");
}
