/** Fetch unassigned issues without decision blockers or unfinished children; fail closed on partial listings. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PAGE_LIMIT = 100;
const QUERY = "query($owner:String!,$repo:String!,$cursor:String){repository(owner:$owner,name:$repo){issues(first:100,states:OPEN,after:$cursor){nodes{number assignees(first:1){totalCount} subIssuesSummary{total completed} labels(first:100){totalCount nodes{name}}} pageInfo{hasNextPage endCursor}}}}";

export const ISSUE_CONDITION = [
	"No actionable unassigned issues remain: independently check open unassigned issues using GitHub's parent–sub-issue relationship.",
	"Never select or claim decision-blocked issues or issues with an equivalent decision-blocker label; they require a user or maintainer decision and are ineligible until that label is removed.",
	"Leaves and parents whose children are all closed are candidates. Parents with open children must wait without needing a blocker label.",
	"For eligible parents, verify the requirements, child implementations and merged PRs: closed children alone do not prove delivery. A fully delivered parent still needs verification and closing, not a new implementation or PR.",
	"Check existing open PRs before new work: implementation merely awaiting merge is not a new implementation task and needs no blocker label.",
	"Failed or stalled tests, reproduction, research, missing code, review fixes, unavailable reviewers and paused checkpoints remain actionable engineering, not decision blockers or evidence the loop is finished.",
	"Only a concrete user or maintainer decision justifies creating a blocker; routine implementation and architecture choices belong to the agent. Respect explicit user deferrals.",
	"Assignment means active work; paused work and published PRs merely awaiting merge must not reserve the issue assignment. Preserve other sessions' claims.",
].join(" ");

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
				nodes?: Array<{ number: number; assignees?: { totalCount: number }; subIssuesSummary?: { total: number; completed: number }; labels?: { totalCount: number; nodes: Array<{ name: string }> } }>;
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
			const labels = issue.labels;
			if (!labels || !Number.isSafeInteger(labels.totalCount) || labels.totalCount < 0 ||
				!Array.isArray(labels.nodes) || labels.nodes.length !== labels.totalCount ||
				labels.nodes.some((label) => typeof label?.name !== "string")) {
				throw new Error("GitHub omitted a complete issue label listing.");
			}
			const decisionBlocked = labels.nodes.some(({ name }) =>
				/^(?:decision[\s:_-]+blocked|blocked[\s:_-]+decision|needs[\s:_-]+decision)$/i.test(name.trim()));
			if (!decisionBlocked && issue.assignees.totalCount === 0 && summary.completed === summary.total) candidates.push(issue.number);
		}
		if (!issues.pageInfo.hasNextPage) return candidates;
		const next = issues.pageInfo.endCursor;
		if (!next || seen.has(next)) throw new Error("GitHub issue pagination did not advance.");
		seen.add(next);
		cursor = next;
	}
	throw new Error("GitHub has too many open issues to verify every parent; issue selection stopped.");
}
