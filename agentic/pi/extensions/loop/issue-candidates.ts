/** Fetch every open unassigned GitHub issue without sub-issues; never guess on a partial listing. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PAGE_LIMIT = 100;
const QUERY = "query($owner:String!,$repo:String!,$cursor:String){repository(owner:$owner,name:$repo){issues(first:100,states:OPEN,after:$cursor){nodes{number assignees(first:1){totalCount} subIssues(first:1){totalCount}} pageInfo{hasNextPage endCursor}}}}";

export const ISSUE_CONDITION = "No actionable unassigned issues remain: independently check every open unassigned issue using GitHub's parent–sub-issue relationship. An issue with sub-issues is a non-actionable parent; any unassigned sub-issue without sub-issues remains a candidate. Complex issues without sub-issues must first be decomposed and linked, and remaining leaf issues must have documented blockers or missing clarifications; decision-blocked issues also require the repo's standard decision-blocker label or decision-blocked label";

type Gh = (args: string[], cwd: string, signal?: AbortSignal) => Promise<string>;

async function runGh(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
	// Select the checkout's remote, not a GH_REPO override inherited from the shell.
	const env = { ...process.env };
	delete env.GH_REPO;
	const { stdout } = await execFileAsync("gh", args, { cwd, env, signal, timeout: 30_000, maxBuffer: 2_000_000 });
	return stdout.trim();
}

/** All candidate numbers, not just the first page. Parents are excluded by GitHub's actual sub-issue relationship. */
export async function listUnassignedLeafIssues(cwd: string, signal?: AbortSignal, gh: Gh = runGh): Promise<number[]> {
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
				nodes?: Array<{ number?: number; assignees?: { totalCount?: number }; subIssues?: { totalCount?: number } }>;
				pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
			} } };
		};
		const issues = response.data?.repository?.issues;
		if (response.errors?.length || !issues || !Array.isArray(issues.nodes) ||
			typeof issues.pageInfo?.hasNextPage !== "boolean") {
			throw new Error("GitHub did not return a complete issue/sub-issue listing.");
		}
		for (const issue of issues.nodes) {
			if (!Number.isSafeInteger(issue.number) || typeof issue.assignees?.totalCount !== "number" ||
				typeof issue.subIssues?.totalCount !== "number") {
				throw new Error("GitHub omitted an issue's assignment or sub-issue relationship.");
			}
			if (issue.assignees.totalCount === 0 && issue.subIssues.totalCount === 0) candidates.push(issue.number!);
		}
		if (!issues.pageInfo.hasNextPage) return candidates;
		const next = issues.pageInfo.endCursor;
		if (!next || seen.has(next)) throw new Error("GitHub issue pagination did not advance.");
		seen.add(next);
		cursor = next;
	}
	throw new Error("GitHub has too many open issues to verify every parent; issue selection stopped.");
}
