/** Claim an unassigned leaf issue under a cross-machine GitHub ref mutex. */
import { execFile } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const IDENTITY_QUERY = "query($owner:String!,$repo:String!){viewer{login} repository(owner:$owner,name:$repo){defaultBranchRef{target{oid}}}}";
const ISSUE_QUERY = "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){number state assignees(first:100){totalCount nodes{login}} subIssues(first:1){totalCount}}}}";

async function runGh(args, cwd) {
	const env = { ...process.env, GH_PROMPT_DISABLED: "1" };
	delete env.GH_REPO;
	const { stdout } = await execFileAsync("gh", args, {
		cwd, env, timeout: 30_000, maxBuffer: 2_000_000,
	});
	return stdout.trim() ? JSON.parse(stdout) : undefined;
}

/** Returns claimed, unavailable, or busy. Errors never grant ownership. */
export async function claimIssue(number, cwd = process.cwd(), gh = runGh) {
	if (!Number.isSafeInteger(number) || number < 1) throw new Error("Issue number must be a positive integer.");
	const checkout = await gh(["repo", "view", "--json", "nameWithOwner,url"], cwd);
	if (!/^[\w.-]+\/[\w.-]+$/.test(checkout?.nameWithOwner)) throw new Error("Could not identify the checkout's repository.");
	const url = new URL(checkout.url);
	if (url.protocol !== "https:" || url.pathname.replace(/\/$/, "").toLowerCase() !== `/${checkout.nameWithOwner}`.toLowerCase()) {
		throw new Error("GitHub returned an inconsistent repository URL.");
	}
	const repository = checkout.nameWithOwner;
	const [owner, repo] = repository.split("/");
	const api = (args) => gh(["api", "--hostname", url.hostname, ...args], cwd);
	const graphql = async (query, fields = []) => {
		const response = await api(["graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`, ...fields]);
		if (response?.errors?.length || !response?.data?.repository) throw new Error("GitHub returned incomplete claim data.");
		return response.data;
	};
	const identity = await graphql(IDENTITY_QUERY);
	const login = identity.viewer?.login;
	const sha = identity.repository.defaultBranchRef?.target?.oid;
	if (typeof login !== "string" || !login || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("GitHub omitted the viewer or default branch commit.");
	const lockRef = `refs/pi/issue-claims/${number}`;
	const refsEndpoint = `repos/${repository}/git/refs`;
	try {
		// GitHub creates a ref only if absent: the winner alone enters the mutex.
		await api([refsEndpoint, "--method", "POST", "-f", `ref=${lockRef}`, "-f", `sha=${sha}`]);
	} catch (error) {
		let response;
		try { response = JSON.parse(error.stdout); } catch { /* Unknown outcomes fail closed below. */ }
		if (response?.message === "Reference already exists" && String(response.status) === "422") {
			return { status: "busy", issue: number, repository, lockRef };
		}
		throw new Error(`Could not acquire ${repository} ${lockRef}; do not implement or delete the lock. ${error.message}`, { cause: error });
	}
	try {
		const snapshot = async () => {
			const data = await graphql(ISSUE_QUERY, ["-F", `number=${number}`]);
			const issue = data.repository.issue;
			if (issue?.number !== number || !["OPEN", "CLOSED"].includes(issue.state) ||
				!Number.isSafeInteger(issue.assignees?.totalCount) || issue.assignees.totalCount < 0 ||
				!Array.isArray(issue.assignees.nodes) ||
				!Number.isSafeInteger(issue.subIssues?.totalCount) || issue.subIssues.totalCount < 0) {
				throw new Error("GitHub omitted the issue's state, assignment, or sub-issue relationship.");
			}
			return issue;
		};
		const before = await snapshot();
		let status = "unavailable";
		// @me is NOT proof of this session's ownership. Any assignment means skip.
		if (before.state === "OPEN" && before.assignees.totalCount === 0 && before.subIssues.totalCount === 0) {
			await api([`repos/${repository}/issues/${number}/assignees`, "--method", "POST", "-f", `assignees[]=${login}`]);
			const after = await snapshot();
			if (after.state !== "OPEN" || after.subIssues.totalCount !== 0 || after.assignees.totalCount !== 1 ||
				after.assignees.nodes.length !== 1 || after.assignees.nodes[0]?.login !== login) {
				throw new Error("Issue assignment could not be verified; do not implement or remove any assignee.");
			}
			status = "claimed";
		}
		// Never time out/reclaim locks. A crash or uncertain write leaves a lock
		// for explicit recovery after verifying the previous session has stopped.
		await api([`${refsEndpoint}/pi/issue-claims/${number}`, "--method", "DELETE"]);
		return { status, issue: number, repository, assignee: status === "claimed" ? login : undefined };
	} catch (error) {
		throw new Error(`Claim failed; retained ${repository} ${lockRef}. Do not implement, retry assignment, or remove the lock without confirming the owning session has stopped. ${error.message}`, { cause: error });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const argument = process.argv[2];
		if (process.argv.length !== 3 || !/^[1-9]\d*$/.test(argument ?? "")) throw new Error("Usage: node claim-issue.mjs ISSUE_NUMBER");
		const result = await claimIssue(Number(argument));
		console.log(JSON.stringify(result));
		process.exitCode = result.status === "claimed" ? 0 : result.status === "busy" ? 4 : 3;
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
